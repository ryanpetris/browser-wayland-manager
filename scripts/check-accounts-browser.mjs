// Run in proxy-browser with this script mounted at /src/scripts/check-accounts-browser.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const admin = { id: 'admin-fixture', username: 'fixture', display_name: 'Fixture', role: 'administrator', enabled: true };
const alice = { id: 'alice-fixture', username: 'alice', display_name: 'Alice Ashby', role: 'user', enabled: true };
const bob = { id: 'bob-fixture', username: 'bob', display_name: 'Bob Blake', role: 'administrator', enabled: false };
let users = [admin, alice, bob];
let identity = admin;

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    // Innkeeper serves the same document for every in-app path; the browser routes it.
    const file = path === '/app.js' || path === '/app.css' ? path : '/index.html';
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(await readFile(new URL('../web/dist' + file, import.meta.url)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const errors = [], writes = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === '/api/me' && method === 'GET') {
      await route.fulfill({ json: { user: identity, csrf_token: 'fixture-csrf', session_expires_at_ms: Date.now() + 7 * 86400000, server_time_ms: Date.now() } });
    } else if (path === '/api/sessions' && method === 'GET') {
      await route.fulfill({ json: { sessions: [], version: 'fixture' } });
    } else if (path === '/api/users' && method === 'GET') {
      await route.fulfill({ json: { users } });
    } else if (path === '/api/users' && method === 'POST') {
      writes.push({ path, body: request.postDataJSON() });
      await route.fulfill({ status: 201, json: { user: alice } });
    } else if (path.startsWith('/api/users/') && method === 'PATCH') {
      writes.push({ path, body: request.postDataJSON() });
      await route.fulfill({ json: { user: users.find(u => path.endsWith(u.id)) ?? alice } });
    } else if (path.startsWith('/api/users/') && method === 'DELETE') {
      writes.push({ path, body: null });
      users = users.filter(u => !path.endsWith(u.id));
      await route.fulfill({ status: 204, body: '' });
    } else {
      errors.push(`Unexpected API request: ${method} ${path}`);
      await route.fulfill({ status: 500, json: {} });
    }
  });

  // The directory lists every account and marks this one.
  await page.goto(`${origin}/users`);
  const rows = page.locator('article').filter({ has: page.getByRole('link') });
  await page.getByRole('link', { name: alice.display_name, exact: true }).waitFor();
  await page.getByRole('link', { name: bob.display_name, exact: true }).waitFor();

  // Each account's page carries that account's own values.
  await page.getByRole('link', { name: alice.display_name, exact: true }).click();
  await page.getByRole('heading', { name: alice.display_name, exact: true }).waitFor();
  assert.equal(await page.locator('input[name="username"]').inputValue(), alice.username);
  await page.getByRole('link', { name: 'Users', exact: true }).first().click();
  await page.getByRole('link', { name: bob.display_name, exact: true }).click();
  await page.getByRole('heading', { name: bob.display_name, exact: true }).waitFor();
  assert.equal(await page.locator('input[name="username"]').inputValue(), bob.username);
  assert.equal(await page.locator('select[name="role"]').inputValue(), bob.role);
  assert.equal(await page.locator('input[name="enabled"]').isChecked(), bob.enabled);

  // A history jump straight from one account to another shows the account it names, and saves it.
  await page.evaluate(() => history.go(-2));
  await page.getByRole('heading', { name: alice.display_name, exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/users/${alice.id}`);
  assert.equal(await page.locator('input[name="username"]').inputValue(), alice.username);
  assert.equal(await page.locator('select[name="role"]').inputValue(), alice.role);
  assert.equal(await page.locator('input[name="enabled"]').isChecked(), alice.enabled);
  const saved = page.waitForRequest(r => r.method() === 'PATCH');
  await page.getByRole('button', { name: 'Save Account', exact: true }).click();
  assert.deepEqual((await saved).postDataJSON(), {
    username: alice.username, display_name: alice.display_name, role: alice.role, enabled: alice.enabled,
  });

  // Deleting asks first, cancels cleanly, and returns to the directory once confirmed.
  const before = writes.length;
  await page.getByRole('button', { name: 'Delete Account', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: `Delete ${alice.display_name}`, exact: true });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirm.waitFor({ state: 'detached' });
  assert.equal(writes.length, before);
  await page.getByRole('button', { name: 'Delete Account', exact: true }).click();
  await confirm.getByRole('button', { name: 'Delete Account', exact: true }).click();
  await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/users');
  assert.deepEqual(writes.slice(before), [{ path: `/api/users/${alice.id}`, body: null }]);
  assert.equal(await rows.count(), users.length);

  // A password reset asks for a long enough password before it sends one.
  await page.getByRole('link', { name: bob.display_name, exact: true }).click();
  await page.getByRole('heading', { name: bob.display_name, exact: true }).waitFor();
  const short = writes.length;
  await page.locator('input[name="reset_password"]').fill('too short');
  await page.getByRole('button', { name: 'Reset Password', exact: true }).click();
  assert.equal(writes.length, short);

  // Your own account states its username and offers only what you may change.
  await page.getByRole('link', { name: identity.display_name, exact: true }).click();
  await page.getByRole('heading', { name: 'Your Account', exact: true }).waitFor();
  assert.equal(await page.locator('input[name="username"]').count(), 0);
  assert.equal(await page.locator('input[name="display_name"]').inputValue(), identity.display_name);

  // A normal user reaches neither the directory nor an account page.
  identity = alice;
  await page.goto(`${origin}/users`);
  await page.getByRole('heading', { name: 'Administrators Only', exact: true }).waitFor();
  await page.goto(`${origin}/users/${bob.id}`);
  await page.getByRole('heading', { name: 'Administrators Only', exact: true }).waitFor();
  await page.goto(`${origin}/users/new`);
  await page.getByRole('heading', { name: 'Administrators Only', exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Users', exact: true }).count(), 0);

  assert.deepEqual(errors, []);
  console.log('Account pages: directory, per-account identity across history jumps, save payload, deletion, password rules and administrator guards passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
