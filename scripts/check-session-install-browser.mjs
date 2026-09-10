// Run in proxy-browser with this script mounted at /src/scripts/check-session-install-browser.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

let session = {
  id: 'install-fixture', name: 'Install fixture', distribution: 'debian', packages: [],
  access_role: 'manager', status: 'stopped', installed_version: '0.7.3-1', docker_args: [],
  startup_command: '', screen_size: null, kiosk: false, settings_pending: false, port: 0, started_ms: 0,
  expected_version: '0.7.3', version_status: 'current', repair_available: false, timings: {},
};
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
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [], installs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
      if (/Content Security Policy|Refused to/i.test(message.text())) errors.push(`refused: ${message.text()}`);
    });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/me') {
      await route.fulfill({ json: { user: { id: 'fixture', username: 'fixture', display_name: 'Fixture', role: 'administrator' }, csrf_token: 'fixture-csrf', session_expires_at_ms: Date.now() + 7 * 86400000, server_time_ms: Date.now() } });
    } else if (path === '/api/sessions' && request.method() === 'GET') {
      await route.fulfill({ json: { sessions: [session], version: 'fixture' } });
    } else if (path === `/api/sessions/${session.id}/upgrade` && request.method() === 'POST') {
      installs.push(request.postDataJSON());
      await route.fulfill({ status: 202, body: '' });
    } else if (path === '/api/users') {
      await route.fulfill({ json: { users: [] } });
    } else if (path.endsWith('/access')) {
      await route.fulfill({ json: { assignments: [] } });
    } else if (path.endsWith('/logs')) {
      await route.fulfill({ json: { text: 'fixture log' } });
    } else if (path.endsWith('/preview')) {
      await route.fulfill({ status: 404, body: '' });
    } else {
      errors.push(`Unexpected API request: ${request.method()} ${path}`);
      await route.fulfill({ status: 500, json: {} });
    }
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const detail = `${origin}/sessions/${session.id}`;
  const installed = page.locator('dl div').filter({ hasText: 'Installed' }).locator('dd');
  // The grid links into the session; every install control lives on that page.
  await page.goto(origin);
  await page.locator('article.session').getByRole('link', { name: session.name, exact: true }).click();
  await page.getByRole('heading', { name: session.name, exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/sessions/${session.id}`);
  for (const [status, label] of [['older', 'Upgrade'], ['newer', 'Downgrade'], ['current', 'Reinstall'], ['unknown', 'Reinstall']]) {
    session.version_status = status;
    for (const state of ['running', 'stopped']) {
      session.status = state;
      await page.goto(detail);
      const button = page.getByRole('button', { name: label, exact: true });
      await button.waitFor();
      assert.equal(await button.isEnabled(), true);
      assert.equal(await installed.innerText(), '0.7.3-1');
      const count = installs.length;
      await button.click();
      const confirm = page.getByRole('dialog', { name: `${label} ${session.name}`, exact: true });
      await confirm.waitFor();
      assert.equal(await confirm.locator('p').innerText(), 'This will close all running applications and stop the session. Unsaved changes may be lost.');
      assert.equal(installs.length, count);
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      await confirm.waitFor({ state: 'detached' });
      assert.equal(installs.length, count);
      await button.click();
      await confirm.waitFor();
      await page.keyboard.press('Escape');
      await confirm.waitFor({ state: 'detached' });
      assert.equal(installs.length, count);
      await button.click();
      await confirm.getByRole('button', { name: 'Close Dialog', exact: true }).click();
      await confirm.waitFor({ state: 'detached' });
      assert.equal(installs.length, count);
      await button.click();
      const request = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/upgrade'));
      await confirm.getByRole('button', { name: label, exact: true }).click();
      assert.deepEqual((await request).postDataJSON(), {});
      await confirm.waitFor({ state: 'detached' });
    }
  }
  session.installed_version = null;
  session.repair_available = true;
  await page.goto(detail);
  const reinstall = page.getByRole('button', { name: 'Reinstall', exact: true });
  await reinstall.waitFor();
  assert.equal(await reinstall.isEnabled(), true);
  assert.equal(await installed.innerText(), 'Unavailable');
  assert.match(await page.textContent('body'), /Elsewhere installation is incomplete/);
  await reinstall.click();
  const repair = page.getByRole('dialog', { name: `Reinstall ${session.name}`, exact: true });
  await repair.getByRole('button', { name: 'Cancel', exact: true }).click();
  await repair.waitFor({ state: 'detached' });
  assert.equal(installs.length, 8);
  await reinstall.click();
  const repairRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/upgrade'));
  await repair.getByRole('button', { name: 'Reinstall', exact: true }).click();
  assert.deepEqual((await repairRequest).postDataJSON(), {});
  await repair.waitFor({ state: 'detached' });
  for (const status of ['preparing', 'upgrading', 'failed', 'cancelled']) {
    session.status = status;
    await page.goto(detail);
    await reinstall.waitFor();
    assert.equal(await reinstall.isDisabled(), true);
  }
  const managed = { ...session };
  for (const role of ['viewer', 'interactive']) {
    // The server sends a non-manager only these fields, so the check sees the same shape.
    session = {
      id: managed.id, name: managed.name, distribution: managed.distribution, status: 'stopped',
      stage: managed.stage, installed_version: managed.installed_version,
      expected_version: managed.expected_version, version_status: managed.version_status, access_role: role,
    };
    await page.goto(detail);
    await page.getByRole('heading', { name: session.name, exact: true }).waitFor();
    assert.equal(await reinstall.count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Destroy Session', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Logs', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).count(), 0);
  }
  assert.equal(installs.length, 9);
  assert.deepEqual(errors, []);
  console.log('Session installation: labels, installed version, confirmation, cancellation, requests, incomplete packages, states and manager access passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
