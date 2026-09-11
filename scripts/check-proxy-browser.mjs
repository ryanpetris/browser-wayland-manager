// Run in the browser Docker rig while check-proxy-desktops.py waits for completion.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, request } from '../web/node_modules/playwright-core/index.mjs';

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
  manager.setDefaultTimeout(15000);
  const refused = [];
  manager.on('console', message => {
    if (/Content Security Policy|Refused to/i.test(message.text())) refused.push(message.text());
  });
  await manager.goto(origin);
  await manager.getByLabel('Username', {exact:true}).fill('fixture');
  await manager.getByLabel('Password', {exact:true}).fill(password);
  await manager.getByRole('button', { name: 'Sign In', exact: true }).click();
  await manager.getByRole('link', {name:'Fixture Administrator',exact:true}).waitFor();
  // Replace the cookie while this tab retains its previous CSRF value.
  const previous = await (await context.request.get(origin + '/api/me')).json();
  const replacement = await request.newContext({ignoreHTTPSErrors:true});
  try {
    const login = await replacement.post(origin + '/api/login', {headers:{Origin:origin},data:{username:'fixture',password}});
    assert.equal(login.status(),200);
    assert.notEqual((await login.json()).csrf_token,previous.csrf_token);
    await context.addCookies((await replacement.storageState()).cookies);
  } finally {
    await replacement.dispose();
  }
  const recovered = manager.waitForResponse(r=>new URL(r.url()).pathname==='/api/me' && r.status()===200);
  await manager.evaluate(() => window.dispatchEvent(new Event('focus')));
  await recovered;
  await manager.getByRole('link', {name:'Fixture Administrator',exact:true}).click();
  await manager.getByRole('heading',{name:'Your Account',exact:true}).waitFor();
  const saved=manager.waitForResponse(r=>new URL(r.url()).pathname==='/api/me' && r.request().method()==='PATCH');
  await manager.getByRole('button',{name:'Save Display Name',exact:true}).click();
  assert.equal((await saved).status(),200);
  console.log('Checking account creation');
  await manager.getByRole('navigation',{name:'Sections'}).getByRole('link',{name:'Users',exact:true}).click();
  await manager.getByRole('link',{name:'New User',exact:true}).click();
  await manager.getByLabel('Username',{exact:true}).fill('browser-account');
  await manager.getByLabel('Display name',{exact:true}).fill('Browser account');
  await manager.getByLabel('Password',{exact:true}).fill(password);
  const createdUser=manager.waitForResponse(r=>new URL(r.url()).pathname==='/api/users' && r.request().method()==='POST');
  await manager.getByRole('button',{name:'Create User',exact:true}).click();
  assert.equal((await createdUser).status(),201);
  const accountId=(await (await context.request.get(origin+'/api/users')).json()).users.find(u=>u.username==='browser-account').id;
  console.log('Checking account rename');
  await manager.getByRole('link',{name:'Browser account',exact:true}).click();
  await manager.getByRole('heading',{name:'Browser account',exact:true}).waitFor();
  await manager.getByLabel('Username',{exact:true}).fill('browser-renamed');
  const renamed=manager.waitForResponse(r=>new URL(r.url()).pathname==='/api/users/'+accountId && r.request().method()==='PATCH');
  await manager.getByRole('button',{name:'Save Account',exact:true}).click();
  assert.equal((await renamed).status(),200);
  console.log('Checking sharing');
  const nav=manager.getByRole('navigation',{name:'Sections'});
  await nav.getByRole('link',{name:'Sessions',exact:true}).click();
  const cards = manager.locator('.session');
  await cards.filter({hasText:'Proxy '+sessions[0].distribution}).getByRole('link',{name:'Proxy '+sessions[0].distribution,exact:true}).click();
  await manager.getByRole('heading',{name:'People with Access',exact:true}).waitFor();
  const assigned=manager.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/access/'+accountId) && r.request().method()==='PUT');
  await manager.getByLabel('Access for Browser account',{exact:true}).selectOption('viewer');
  assert.equal((await assigned).status(),200);
  await nav.getByRole('link',{name:'Sessions',exact:true}).click();
  await cards.first().waitFor();
  const userContext=await browser.newContext({ignoreHTTPSErrors:true});
  const userPage=await userContext.newPage();userPage.setDefaultTimeout(15000);
  async function signInUser(secret) {
    await userPage.getByLabel('Username',{exact:true}).fill('browser-renamed');
    await userPage.getByLabel('Password',{exact:true}).fill(secret);
    await userPage.getByRole('button',{name:'Sign In',exact:true}).click();
    await userPage.getByRole('link',{name:'Browser account',exact:true}).waitFor();
  }
  await userPage.goto(origin);await signInUser(password);
  await userPage.locator('.session').waitFor();
  assert.equal(await userPage.locator('.session').count(),1);
  // Account administration is out of reach for a normal user, by navigation and by address.
  assert.equal(await userPage.getByRole('link',{name:'Users',exact:true}).count(),0);
  await userPage.goto(origin+'/users');
  await userPage.getByRole('heading',{name:'Administrators Only',exact:true}).waitFor();
  // The shared machine carries no management for a Viewer, and no sharing for a normal user.
  await userPage.goto(origin+'/sessions/'+sessions[0].id);
  await userPage.getByRole('heading',{name:'Proxy '+sessions[0].distribution,exact:true}).waitFor();
  await userPage.getByRole('button',{name:'Open Desktop',exact:true}).waitFor();
  for (const absent of ['People with Access','Logs','Elsewhere Version','Danger Zone']) {
    assert.equal(await userPage.getByRole('heading',{name:absent,exact:true}).count(),0,absent);
  }
  for (const absent of ['Edit Settings','Start','Stop','Relaunch','Reinstall','Destroy Session']) {
    assert.equal(await userPage.getByRole('button',{name:absent,exact:true}).count(),0,absent);
  }
  await userPage.getByRole('link',{name:'Browser account',exact:true}).click();
  await userPage.getByRole('heading',{name:'Your Account',exact:true}).waitFor();
  // Only an Administrator can rename an account, so the username is stated rather than offered.
  assert.equal(await userPage.locator('input[name="display_name"]').count(),1);
  assert.equal(await userPage.locator('input[name="username"]').count(),0);
  await userPage.getByLabel('Current password',{exact:true}).fill(password);
  await userPage.getByLabel('New password',{exact:true}).fill('browser replacement password');
  await userPage.getByRole('button',{name:'Change Password and Sign Out',exact:true}).click();
  await signInUser('browser replacement password');
  await userContext.close();
  assert.deepEqual(refused, []);
  console.log('Account creation, rename, sharing, user restrictions, password change and re-login passed');
  const current=await (await context.request.get(origin+'/api/me')).json();
  assert.equal((await context.request.delete(origin+'/api/users/'+accountId,{headers:{Origin:origin,'X-Innkeeper-CSRF':current.csrf_token},data:{}})).status(),204);

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
    await page.keyboard.type('printf proxy-terminal-ok > /home/elsewhere/proxy-terminal.txt; (while paplay /tmp/tone.wav; do :; done) >/home/elsewhere/tone.log 2>&1 &');
    await page.keyboard.press('Enter');
    const terminalFile = origin + prefix + '/api/files/proxy-terminal.txt?path=/home/elsewhere';
    for (let attempt = 0; ; attempt++) {
      const response = await context.request.get(terminalFile, { headers: auth });
      if (response.ok() && await response.text() === 'proxy-terminal-ok') break;
      assert.ok(attempt < 30, 'Terminal command did not arrive');
      await page.waitForTimeout(100);
    }
    await page.evaluate(() => elsewhere.resumeAudio());
    await page.waitForFunction(() => {
      const audio = elsewhere.store.get().stats.audio;
      return audio?.decoded > 0 && audio.state === 'running' && audio.signalPeak > 0.01;
    }, null, { timeout: 30000 }).catch(async error => {
      console.error('Audio stats:', await page.evaluate(() => elsewhere.store.get().stats.audio));
      console.error('Tone output:', await (await context.request.get(origin + prefix + '/api/files/tone.log?path=/home/elsewhere', { headers: auth })).text());
      throw error;
    });
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
    console.log(`${session.distribution}: Open/token isolation, assets, decoded video and audible test tone, files, MCP, terminal, direct WebRTC and fallback, viewer passed`);
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
