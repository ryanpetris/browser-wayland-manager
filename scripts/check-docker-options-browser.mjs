// Run in proxy-browser with this script mounted at /src/scripts/check-docker-options-browser.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const dockerArgs = ['--security-opt=seccomp=unconfined', '--security-opt=apparmor=unconfined', '--cap-add=SYS_ADMIN'];
const session = {
  id: 'docker-options-fixture', name: 'Steam', distribution: 'debian', packages: [],
  docker_args: dockerArgs, status: 'stopped', screen_size: null, kiosk: false,
  startup_command: '', settings_pending: false,
};
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = path === '/' ? '/index.html' : path;
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(await readFile(new URL('../web/dist' + file, import.meta.url)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.headers().authorization !== 'Bearer fixture-admin') {
      await route.fulfill({ status: 401, json: {} });
    } else if (path === '/api/sessions' && request.method() === 'GET') {
      await route.fulfill({ json: { sessions: [session], version: 'fixture' } });
    } else if (path === '/api/sessions' && request.method() === 'POST') {
      await route.fulfill({ status: 202, json: { id: 'created-fixture' } });
    } else if (path === `/api/sessions/${session.id}/settings` && request.method() === 'PUT') {
      await route.fulfill({ json: { ...session, ...request.postDataJSON() } });
    } else {
      errors.push(`Unexpected API request: ${request.method()} ${path}`);
      await route.fulfill({ status: 500, json: {} });
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('Administrator token').fill('fixture-admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'New session', exact: true });
  await create.getByText('Import profile', { exact: true }).click();
  await create.getByText('Advanced Docker options', { exact: true }).click();
  const options = create.locator('textarea[name="docker_args"]');
  async function importProfile(profile) {
    await create.getByLabel('Profile JSON').fill(JSON.stringify(profile));
    await create.getByRole('button', { name: 'Apply profile', exact: true }).click();
  }
  await importProfile({ name: 'Steam', docker_args: dockerArgs });
  assert.equal(await options.inputValue(), dockerArgs.join('\n'));
  assert.equal(await options.evaluate(element => element.readOnly), false);
  for (const invalid of ['--cap-add=SYS_ADMIN', ['--cap-add=SYS_ADMIN\n--cap-drop=NET_RAW']]) {
    await importProfile({ name: 'Invalid profile', docker_args: invalid });
    assert.equal(await create.getByRole('alert').innerText(), 'Invalid profile field types.');
    assert.equal(await options.inputValue(), dockerArgs.join('\n'));
    assert.equal(await create.getByLabel('Session name').inputValue(), 'Steam');
  }
  await importProfile({ name: 'Legacy profile' });
  assert.equal(await options.inputValue(), '');
  const legacyRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await create.getByRole('button', { name: 'Create session', exact: true }).click();
  assert.deepEqual((await legacyRequest).postDataJSON().docker_args, []);
  await create.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await create.getByText('Import profile', { exact: true }).click();
  await create.getByText('Advanced Docker options', { exact: true }).click();
  await importProfile({ name: 'Steam', docker_args: dockerArgs });
  assert.equal(await options.inputValue(), dockerArgs.join('\n'));
  await options.fill(`  ${dockerArgs.join('\n\n')}  \n`);
  const createRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions');
  await create.getByRole('button', { name: 'Create session', exact: true }).click();
  assert.deepEqual((await createRequest).postDataJSON().docker_args, dockerArgs);
  await create.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'Edit settings', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit settings', exact: true });
  await edit.getByText('Advanced Docker options', { exact: true }).click();
  const savedOptions = edit.locator('textarea[name="docker_args"]');
  assert.equal(await savedOptions.inputValue(), dockerArgs.join('\n'));
  assert.equal(await savedOptions.evaluate(element => element.readOnly), true);
  await edit.getByLabel('Session name').fill('Steam renamed');
  const saveRequest = page.waitForRequest(request => request.method() === 'PUT');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  assert.deepEqual((await saveRequest).postDataJSON(), {
    name: 'Steam renamed', screen_size: null, kiosk: false, startup_command: '',
  });
  await edit.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('Docker options: profile imports, legacy reset, repeated creation arguments, read-only settings and Save payload passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
