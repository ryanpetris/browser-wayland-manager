#!/usr/bin/env python3
"""Run fresh real-package desktops in the Docker rig; optionally wait for browser checks."""
import json
import os
from pathlib import Path
import ssl
import subprocess
import time
import urllib.request
import uuid

work = Path('/work')
for marker in ('browser.json', 'browser-done'):
    (work / marker).unlink(missing_ok=True)
data = work / 'data'
data.mkdir(exist_ok=True)
# Reserve host ports already in use by unrelated containers in this disposable database.
reserved = []
ids = subprocess.check_output(['docker', 'ps', '-aq'], text=True).split()
if ids:
    for info in json.loads(subprocess.check_output(['docker', 'inspect', *ids])):
        for bindings in (info['HostConfig'].get('PortBindings') or {}).values():
            for binding in bindings or []:
                port = int(binding['HostPort'] or 0)
                if 19500 <= port < 20000:
                    reserved.append(dict(id=str(uuid.uuid4()), name='Reserved fixture port', distribution='debian', packages=[],
                                         port=port, status='failed', stage='download', error=None))
(data / 'state.json').write_text(json.dumps(dict(owner=str(uuid.uuid4()), sessions=reserved)))
cert, key = work / 'cert.pem', work / 'key.pem'
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
                '-keyout',str(key),'-out',str(cert)],check=True,capture_output=True)
env = dict(os.environ, INNKEEPER_DATA_DIR=str(data), INNKEEPER_LISTEN='0.0.0.0:29301',
           INNKEEPER_TLS_CERT=str(cert), INNKEEPER_TLS_KEY=str(key), INNKEEPER_LOCAL_ELSEWHERE='/local/manifest.json')
log = (work/'manager.log').open('w')
manager = subprocess.Popen(['elsewhere-innkeeper'],env=env,stdout=log,stderr=log)
context = ssl._create_unverified_context()
origin = 'https://127.0.0.1:29301'
created = []

def api(path, method='GET', body=None):
    req = urllib.request.Request(origin+'/api'+path,method=method,data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization':'Bearer '+(data/'admin-token').read_text().strip(),'Content-Type':'application/json'})
    with urllib.request.urlopen(req,context=context,timeout=20) as response:
        body=response.read()
        return json.loads(body) if body else None

def wait(test, timeout=120):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if manager.poll() is not None: raise AssertionError('Manager exited')
        if test(): return
        time.sleep(1)
    raise AssertionError('Timed out')

def state(sid):
    return next(s for s in api('/sessions')['sessions'] if s['id']==sid)

try:
    wait(lambda:(data/'admin-token').exists())
    time.sleep(1)
    browser=[]
    for distro in ('arch','debian'):
        sid=api('/sessions','POST',dict(name='Proxy '+distro,distribution=distro,packages=['foot'],startup_command='foot',screen_size={'width':640,'height':480}))['id']
        created.append(sid)
        def ready():
            s=state(sid)
            if s['status']=='failed': raise AssertionError(s)
            return s['status']=='running'
        wait(ready,600)
        name='innkeeper-'+sid
        info=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
        bindings=info['HostConfig']['PortBindings']
        port=state(sid)['port']
        launch = subprocess.check_output(['docker', 'top', name, '-eo', 'pid,args'], text=True)
        commands = [line.split(None, 1)[1] for line in launch.splitlines()[1:] if len(line.split(None, 1)) == 2]
        desktop = next(line for line in commands if line.startswith('elsewhere ') and '--url-prefix' in line)
        assert ('--rtc-addr' in desktop) == bool(env.get('INNKEEPER_RTC_ADDR'))
        assert '--rtc-port ' + str(port) in desktop
        assert '19443/tcp' not in bindings
        assert bindings[str(port)+'/udp']==[{'HostIp':'0.0.0.0','HostPort':str(port)}]
        tokens=[subprocess.check_output(['docker','exec','--user','elsewhere','--env','HOME=/home/elsewhere',name,'elsewhere','token',*args],text=True).removesuffix('\n') for args in ([],['--viewer'])]
        link=api('/sessions/'+sid+'/link','POST')['url']
        with urllib.request.urlopen(origin+link.split('#')[0],context=context) as response:
            assert ('<base href="/e/'+sid+'/">').encode() in response.read()
        req=urllib.request.Request(origin+'/e/'+sid+'/api/screenshot.png',headers={'Authorization':'Bearer '+tokens[1]})
        with urllib.request.urlopen(req,context=context,timeout=20) as response: assert response.read().startswith(b'\x89PNG')
        req=urllib.request.Request(origin+'/api/sessions/'+sid+'/preview?width=320',headers={'Authorization':'Bearer '+(data/'admin-token').read_text().strip()})
        with urllib.request.urlopen(req,context=context,timeout=20) as response: assert response.read().startswith(b'\x89PNG')
        api('/sessions/'+sid+'/stop','POST')
        api('/sessions/'+sid+'/start','POST')
        wait(ready)
        browser.append(dict(id=sid,link=link,viewer=tokens[1],port=port))
        print(distro+': package installation, plain HTTP/prefix, private mapping, public UDP, tokens, screenshots, preview, Stop/Start passed',flush=True)
    (work/'browser.json').write_text(json.dumps(browser))
    if os.environ.get('PROXY_WAIT_BROWSER')=='1':
        wait(lambda:(work/'browser-done').exists(),600)
        assert (work/'browser-done').read_text()=='PASS'
finally:
    for sid in created:
        try: api('/sessions/'+sid,'DELETE')
        except Exception:
            subprocess.run(['docker','rm','-f','innkeeper-'+sid],capture_output=True)
            subprocess.run(['docker','volume','rm','innkeeper-'+sid+'-data'],capture_output=True)
    manager.terminate()
    manager.wait(timeout=10)
    print((work/'manager.log').read_text())
