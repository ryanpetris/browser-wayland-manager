// Run in proxy-browser with this script mounted at /src/scripts/check-sessions-browser.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const administrator = { id: 'admin-fixture', username: 'fixture', display_name: 'Fixture', role: 'administrator' };
const manager = {
  id: 'manager-fixture', name: 'Managed fixture', distribution: 'arch', packages: ['firefox'], docker_args: [],
  startup_command: '', screen_size: null, kiosk: false, settings_pending: false, installed_version: '0.7.3-1',
  repair_available: false, version_error: null, expected_version: '0.7.3', version_status: 'current', port: 0,
  started_ms: 0, status: 'stopped', stage: 'idle', error: null, timings: {}, access_role: 'manager',
};
const running = { ...manager, id: 'running-fixture', name: 'Running fixture', status: 'running', port: 41000, started_ms: 0 };
const working = { ...manager, id: 'working-fixture', name: 'Working fixture', status: 'preparing', stage: 'packages' };
// A non-manager receives only these fields from the server.
const viewer = {
  id: 'viewer-fixture', name: 'Viewer fixture', distribution: 'debian', status: 'running', stage: 'ready',
  installed_version: '0.7.3-1', expected_version: '0.7.3', version_status: 'current', access_role: 'viewer',
};
const pending = { ...running, id: 'pending-fixture', name: 'Pending fixture', settings_pending: true, started_ms: Date.now() - 3600e3 };
const sessions = [running, manager, working, viewer, pending];

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    // Innkeeper serves the same document for every in-app path; the browser routes it.
    const file = path === '/app.js' || path === '/app.css' ? path : '/index.html';
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    // The headers Innkeeper serves, so what the browser refuses there it refuses here too.
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.end(await readFile(new URL('../web/dist' + file, import.meta.url)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const errors = [], starts = [];
  for (const layout of ['grid', 'list']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(`${layout}: ${error.message}`));
    page.on('console', message => {
      if (/Content Security Policy|Refused to/i.test(message.text())) errors.push(`refused: ${message.text()}`);
    });
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/me') {
        await route.fulfill({ json: { user: administrator, csrf_token: 'fixture-csrf', session_expires_at_ms: Date.now() + 7 * 86400000, server_time_ms: Date.now() } });
      } else if (path === '/api/sessions' && request.method() === 'GET') {
        await route.fulfill({ json: { sessions, version: 'fixture' } });
      } else if (path === '/api/sessions' && request.method() === 'POST') {
        // A slow creation, so the reader has time to leave the form before it answers.
        await new Promise(resolve => setTimeout(resolve, 1500));
        await route.fulfill({ status: 202, json: { ...manager, id: 'created-fixture' } });
        return;
      } else if (path === `/api/sessions/${manager.id}/start` && request.method() === 'POST') {
        starts.push(layout);
        await route.fulfill({ status: 202, body: '' });
      } else if (path === '/api/users') {
        await route.fulfill({ json: { users: [administrator] } });
      } else if (path.endsWith('/access')) {
        await route.fulfill({ json: { assignments: [] } });
      } else if (path.endsWith('/logs')) {
        await route.fulfill({ json: { text: 'fixture log' } });
      } else if (path.endsWith('/preview')) {
        await route.fulfill({ status: 404, body: '' });
      } else {
        errors.push(`${layout}: unexpected API request: ${request.method()} ${path}`);
        await route.fulfill({ status: 500, json: {} });
      }
    });
    await page.addInitScript(chosen => localStorage.setItem('innkeeper-layout', chosen), layout);
    await page.goto(origin);
    const cards = page.locator('article.session');
    await cards.first().waitFor();
    assert.equal(await cards.count(), sessions.length, layout);

    // A working session announces its step in a reader's words, where a settled one lists its packages.
    await cards.filter({ hasText: working.name }).getByText('Installing packages…', { exact: true }).waitFor();

    // Start acts on the session and leaves the workspace in place, despite the card being a link.
    const before = starts.length;
    const started = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === `/api/sessions/${manager.id}/start`);
    await cards.filter({ hasText: manager.name }).getByRole('button', { name: 'Start', exact: true }).click();
    await started;
    assert.equal(starts.length, before + 1, layout);
    assert.equal(new URL(page.url()).pathname, '/', layout);

    // Open reaches the connect endpoint in its own tab, and also leaves the workspace in place.
    const popup = page.waitForEvent('popup');
    await cards.filter({ hasText: running.name }).getByRole('button', { name: 'Open', exact: true }).click();
    assert.equal(new URL((await popup).url()).pathname, `/api/sessions/${running.id}/connect`, layout);
    assert.equal(new URL(page.url()).pathname, '/', layout);

    // A session with no action of its own offers none.
    assert.equal(await cards.filter({ hasText: working.name }).getByRole('button').count(), 0, layout);

    // The card itself opens the session, and Back returns to the workspace.
    await cards.filter({ hasText: running.name }).getByRole('link', { name: running.name, exact: true }).click();
    await page.getByRole('heading', { name: running.name, exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/sessions/${running.id}`, layout);
    await page.goBack();
    await page.getByRole('heading', { name: 'Sessions', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/', layout);

    // Filtering narrows the workspace by name and by state.
    await page.getByLabel('Filter sessions', { exact: true }).fill('running');
    await page.waitForFunction(count => document.querySelectorAll('article.session').length === count, 1);
    await page.getByLabel('Filter sessions', { exact: true }).fill('');
    await page.getByLabel('Filter by state', { exact: true }).selectOption('stopped');
    await page.waitForFunction(count => document.querySelectorAll('article.session').length === count, 1);
    await cards.filter({ hasText: manager.name }).waitFor();
    await page.getByLabel('Filter by state', { exact: true }).selectOption('preparing');
    await cards.filter({ hasText: working.name }).waitFor();
    await page.getByLabel('Filter by state', { exact: true }).selectOption('all');
    await page.waitForFunction(count => document.querySelectorAll('article.session').length === count, sessions.length);

    // Progress is reported once, in a bar of its own; the preview only says whether the desktop is up.
    await page.goto(`${origin}/sessions/${working.id}`);
    await page.getByRole('status').filter({ hasText: 'Installing packages…' }).waitFor();
    assert.equal(await page.getByText('Offline', { exact: true }).count(), 1, layout);
    assert.equal(await page.getByRole('button', { name: 'Open Desktop', exact: true }).count(), 0, layout);
    assert.equal(await page.getByRole('button', { name: 'Relaunch', exact: true }).count(), 0, layout);
    // Relaunch is what applies pending settings, so it appears with them and not before.
    await page.goto(`${origin}/sessions/${running.id}`);
    assert.equal(await page.getByRole('button', { name: 'Relaunch', exact: true }).count(), 0, layout);
    await page.goto(`${origin}/sessions/${pending.id}`);
    await page.getByRole('button', { name: 'Relaunch', exact: true }).waitFor();
    await page.getByText('Launched', { exact: true }).waitFor();

    // Logs start folded away and are not fetched until they are opened.
    await page.goto(`${origin}/sessions/${running.id}`);
    const logs = page.locator('details').filter({ has: page.getByRole('heading', { name: 'Logs', exact: true }) });
    await logs.waitFor();
    assert.equal(await logs.evaluate(element => element.open), false, layout);
    await page.waitForTimeout(2500);
    assert.equal(await logs.locator('pre').evaluate(element => element.textContent), 'Loading logs…', layout);
    await page.getByRole('heading', { name: 'Logs', exact: true }).click();
    assert.equal(await logs.evaluate(element => element.open), true, layout);
    await logs.getByText('fixture log', { exact: true }).waitFor();

    // Settings are reachable exactly while they can be saved.
    await page.goto(`${origin}/sessions/${manager.id}`);
    await page.getByRole('link', { name: 'Edit Settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Edit Settings', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save Changes', exact: true }).isEnabled(), true, layout);
    await page.goto(`${origin}/sessions/${working.id}`);
    const shut = page.getByRole('button', { name: 'Edit Settings', exact: true });
    await shut.waitFor();
    assert.equal(await shut.isDisabled(), true, layout);
    assert.equal(await page.getByRole('link', { name: 'Edit Settings', exact: true }).count(), 0, layout);
    await shut.focus().catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    assert.equal(new URL(page.url()).pathname, `/sessions/${working.id}`, layout);
    // Reached by address anyway, the form says why it cannot be saved and holds the commit back.
    await page.goto(`${origin}/sessions/${working.id}/settings`);
    await page.getByText(`This session is ${working.status}.`, { exact: true }).waitFor();
    await page.getByText('Settings can be saved once the session is running or stopped.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save Changes', exact: true }).isDisabled(), true, layout);

    // A creation that answers after the reader has left the form does not pull them back to it.
    await page.goto(`${origin}/sessions/new`);
    await page.getByLabel('Session name', { exact: true }).fill('Abandoned fixture');
    await page.getByRole('button', { name: 'Create Session', exact: true }).click();
    await page.getByRole('link', { name: 'Cancel', exact: true }).click();
    await page.getByRole('heading', { name: 'Sessions', exact: true }).waitFor();
    await page.waitForTimeout(2500);
    assert.equal(new URL(page.url()).pathname, '/', layout);

    // A non-manager's session page carries no management, even for an Administrator's own view.
    await page.goto(`${origin}/sessions/${viewer.id}`);
    await page.getByRole('heading', { name: viewer.name, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open Desktop', exact: true }).waitFor();
    for (const absent of ['Logs', 'Elsewhere Version', 'Danger Zone']) {
      assert.equal(await page.getByRole('heading', { name: absent, exact: true }).count(), 0, `${layout}: ${absent}`);
    }
    // A non-manager is told only what the machine is and that it is up.
    assert.deepEqual(await page.locator('dt').allInnerTexts(), ['Distribution'], layout);
    await page.getByText(viewer.status, { exact: true }).waitFor();
    for (const absent of ['Edit Settings', 'Start', 'Stop', 'Relaunch', 'Reinstall', 'Destroy Session']) {
      assert.equal(await page.getByRole('button', { name: absent, exact: true }).count(), 0, `${layout}: ${absent}`);
    }
    // Sharing is the Administrator's, not the access role's.
    await page.getByRole('heading', { name: 'People with Access', exact: true }).waitFor();
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Sessions workspace: grid and list layouts, stage lines, quick actions over the card link, navigation, filters, settings gating, abandoned creation and non-manager pages passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
