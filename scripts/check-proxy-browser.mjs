// Run in the browser Docker rig while check-proxy-desktops.py waits for completion.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../web/node_modules/playwright-core/index.mjs';

const work = '/work', origin = process.env.PROXY_BROWSER_ORIGIN || 'https://127.0.0.1:29301';
const sessions = JSON.parse(await readFile(work + '/browser.json', 'utf8'));
const password = 'fixture password with enough characters';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
let success = false;
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    const Original = RTCPeerConnection;
    window.peers = [];
    window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); peers.push(this); } };
  });
  const manager = await context.newPage();
  await manager.goto(origin);
  await manager.getByLabel('Username', {exact:true}).fill('fixture');
  await manager.getByLabel('Password', {exact:true}).fill(password);
  await manager.getByRole('button', { name: 'Sign in', exact: true }).click();
  await manager.getByRole('button', {name:'Fixture Administrator',exact:true}).waitFor();
  // Another tab replaces the cookie while this tab retains its previous CSRF value.
  const previous = await (await context.request.get(origin + '/api/me')).json();
  assert.equal((await context.request.post(origin + '/api/logout', {headers:{Origin:origin,'X-Innkeeper-CSRF':previous.csrf_token},data:{}})).status(),204);
  assert.equal((await context.request.post(origin + '/api/login', {headers:{Origin:origin},data:{username:'fixture',password}})).status(),200);
  const recovered = manager.waitForResponse(r=>new URL(r.url()).pathname==='/api/me' && r.status()===200);
  await manager.evaluate(() => window.dispatchEvent(new Event('focus')));
  await recovered;
  await manager.getByRole('button', {name:'Fixture Administrator',exact:true}).click();
  const accountDialog=manager.getByRole('dialog',{name:'Account',exact:true});
  const saved=manager.waitForResponse(r=>new URL(r.url()).pathname==='/api/me' && r.request().method()==='PATCH');
  await accountDialog.getByRole('button',{name:'Save display name',exact:true}).click();
  assert.equal((await saved).status(),200);
  await accountDialog.getByRole('button',{name:'Close dialog',exact:true}).click();
  const cards = manager.locator('.session');
  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index], prefix = '/e/' + session.id;
    const card = cards.filter({ hasText: 'Proxy ' + session.distribution });
    const popup = manager.waitForEvent('popup');
    await card.getByRole('button', { name: 'Open', exact: true }).click();
    const page = await popup;
    await page.waitForFunction(() => window.elsewhere?.store.get().role === 'controller');
    await page.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
    assert.equal(new URL(page.url()).pathname, prefix + '/');
    assert.equal(await page.evaluate(() => window.opener), null);
    assert.equal(await manager.evaluate(() => Object.keys(sessionStorage).length), 0);
    assert.equal(await page.evaluate(() => document.baseURI), origin + prefix + '/');
    assert.ok((await page.evaluate(() => elsewhere.snapshot(null).then(blob => blob.size))) > 0);
    const control = new URLSearchParams(session.link.split('#')[1]).get('token');
    const auth = { Authorization: 'Bearer ' + control };
    const files = origin + prefix + '/api/files/proxy-check.txt?path=/home/elsewhere';
    const payload = 'streamed upload\n'.repeat(100000);
    const put = await context.request.put(files, { headers: auth, data: payload });
    assert.equal(put.status(), 201, await put.text());
    assert.equal(await (await context.request.get(files, { headers: auth })).text(), payload);
    assert.equal((await context.request.delete(files, { headers: auth })).status(), 204);
    const initialize = await context.request.post(origin + prefix + '/mcp', {
      headers: { ...auth, Accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'innkeeper-proxy-check', version: '1' } } },
    });
    assert.ok(initialize.ok(), await initialize.text());
    assert.match(await initialize.text(), /"serverInfo"/);
    const mcpHeaders = { ...auth, Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': initialize.headers()['mcp-session-id'] };
    assert.ok((await context.request.post(origin + prefix + '/mcp', { headers: mcpHeaders, data: { jsonrpc: '2.0', method: 'notifications/initialized' } })).ok());
    const tools = await context.request.post(origin + prefix + '/mcp', { headers: mcpHeaders, data: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.ok(tools.ok(), await tools.text());
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const terminal = page.getByRole('region', { name: 'Terminal', exact: true });
    await terminal.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
    await terminal.locator('textarea').focus();
    await page.keyboard.type('printf proxy-terminal-ok > /home/elsewhere/proxy-terminal.txt');
    await page.keyboard.press('Enter');
    const terminalFile = origin + prefix + '/api/files/proxy-terminal.txt?path=/home/elsewhere';
    for (let attempt = 0; ; attempt++) {
      const response = await context.request.get(terminalFile, { headers: auth });
      if (response.ok() && await response.text() === 'proxy-terminal-ok') break;
      assert.ok(attempt < 30, 'Terminal command did not arrive');
      await page.waitForTimeout(100);
    }
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.evaluate(() => elsewhere.setTransport('webrtc'));
    await page.waitForFunction(() => elsewhere.store.get().videoVia === 'webrtc', null, { timeout: 30000 });
    const remote = await page.evaluate(() => peers.at(-1).remoteDescription.sdp);
    assert.match(remote, new RegExp(`a=candidate:.* 127\\.0\\.0\\.1 ${session.port} `));
    await page.evaluate(() => peers.at(-1).close());
    await page.waitForFunction(() => elsewhere.store.get().videoVia === 'websocket');
    await page.evaluate(() => elsewhere.setTransport('websocket'));
    const viewer = await context.newPage();
    await viewer.goto(origin + prefix + '/#' + new URLSearchParams({ token: session.viewer }));
    await viewer.waitForFunction(() => window.elsewhere?.store.get().role === 'viewer');
    await viewer.waitForFunction(() => elsewhere.store.get().stats.frames > 0);
    assert.equal(await viewer.getByRole('button', {name:'Broadcasts',exact:true}).count(), 0);
    console.log(`${session.distribution}: Open/token isolation, assets, decoded frames, files, MCP, terminal, direct WebRTC and fallback, viewer passed`);
    const identity = await (await context.request.get(origin + '/api/me')).json();
    const users = await (await context.request.get(origin + '/api/users')).json();
    const viewerUser = users.users.find(user => user.username === 'viewer');
    const changed = await context.request.put(origin + `/api/sessions/${session.id}/access/${viewerUser.id}`, {
      headers: {'Origin':origin, 'X-Innkeeper-CSRF':identity.csrf_token}, data:{role:'interactive'},
    });
    assert.equal(changed.status(),200,await changed.text());
    await viewer.waitForFunction(() => elsewhere.store.get().status === 'unauthorized');
    assert.equal(await page.evaluate(() => elsewhere.store.get().status), 'connected');
    assert.equal((await context.request.get(origin + prefix + '/api/me', {headers:{Authorization:'Bearer '+session.viewer}})).status(),401);
    console.log('Revocation disconnects the Viewer while the other user remains connected');
    // Leave controller tabs open to exercise simultaneous instance preferences and tokens.
  }
  success = true;
} finally {
  await browser.close();
  await writeFile(work + '/browser-done', success ? 'PASS' : 'FAIL');
}
