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
from sqlite_fixture import seed, database
from auth_fixture import Client, PASSWORD
import shutil

work = Path('/work')
for marker in ('browser.json', 'browser-done'):
    (work / marker).unlink(missing_ok=True)
data = work / 'data'
data.mkdir(exist_ok=True)
# Reserve host ports already in use by unrelated containers in this disposable database.
reserved = []
reserved_ports = set()
ids = subprocess.check_output(['docker', 'ps', '-aq'], text=True).split()
if ids:
    for info in json.loads(subprocess.check_output(['docker', 'inspect', *ids])):
        for bindings in (info['HostConfig'].get('PortBindings') or {}).values():
            for binding in bindings or []:
                port = int(binding['HostPort'] or 0)
                if 19500 <= port < 20000 and port not in reserved_ports:
                    reserved_ports.add(port)
                    reserved.append(dict(id=str(uuid.uuid4()), name='Reserved fixture port', distribution='debian', packages=[],
                                         port=port, status='failed', stage='download', error=None))
seed(data, reserved, str(uuid.uuid4()))
cert, key = work / 'cert.pem', work / 'key.pem'
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
                '-keyout',str(key),'-out',str(cert)],check=True,capture_output=True)
env = dict(os.environ, INNKEEPER_DATA_DIR=str(data), INNKEEPER_LISTEN='0.0.0.0:29301',
           INNKEEPER_TLS_CERT=str(cert), INNKEEPER_TLS_KEY=str(key))
if Path('/local/manifest.json').exists(): env['INNKEEPER_LOCAL_ELSEWHERE']='/local/manifest.json'
if Path('/packages').exists():
    for distro, filename in [('arch','elsewhere-0.7.3-1-x86_64.pkg.tar.zst'),('debian','elsewhere_0.7.3-1_debian-13_amd64.deb')]:
        cache=data/'packages'/'0.7.3'/'x86_64'/distro;cache.mkdir(parents=True,exist_ok=True);shutil.copyfile(Path('/packages')/filename,cache/filename)
log = (work/'manager.log').open('w')
manager = subprocess.Popen(['elsewhere-innkeeper'],env=env,stdout=log,stderr=log)
context = ssl._create_unverified_context()
origin = 'https://127.0.0.1:29301'
created = []

account=Client(origin)
api=account.api

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
    def listening():
        try:return account.request('/setup')[0]==200
        except (ConnectionError,OSError):return False
    wait(listening)
    account.setup()
    viewer_account=Client(origin)
    viewer_user=api('/users','POST',dict(username='viewer',display_name='Viewer',password=PASSWORD))['user']
    viewer_account.login('viewer')
    browser=[]
    for distro in os.environ.get('PROXY_DISTROS','arch,debian').split(','):
        sid=api('/sessions','POST',dict(name='Proxy '+distro,distribution=distro,packages=['foot'],startup_command='foot',screen_size={'width':640,'height':480}))['id']
        created.append(sid)
        def ready():
            s=state(sid)
            if s['status']=='failed':
                print(api('/sessions/'+sid+'/logs')['text'],flush=True)
                raise AssertionError(s)
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
        api('/sessions/'+sid+'/access/'+viewer_user['id'],'PUT',{'role':'viewer'})
        preview=account.request('/sessions/'+sid+'/preview?width=320')
        assert preview[0]==200 and preview[2].startswith(b'\x89PNG'), preview
        with database(data) as db: assert db.execute("SELECT count(*) FROM instance_tokens WHERE kind='user' AND session_id=?",[sid]).fetchone()[0]==0
        with database(data) as db: internal=db.execute("SELECT secret FROM instance_tokens WHERE kind='internal' AND revoked=0 AND session_id=?",[sid]).fetchone()[0]
        assert internal not in json.dumps(api('/sessions')) and internal not in api('/sessions/'+sid+'/logs')['text']
        link=account.connect(sid)
        viewer_link=viewer_account.connect(sid)
        viewer_token=viewer_link.split('#token=')[1]
        assert account.connect(sid)==link
        with urllib.request.urlopen(origin+link.split('#')[0],context=context) as response:
            assert ('<base href="/e/'+sid+'/">').encode() in response.read()
        req=urllib.request.Request(origin+'/e/'+sid+'/api/screenshot.png',headers={'Authorization':'Bearer '+viewer_token})
        with urllib.request.urlopen(req,context=context,timeout=20) as response: assert response.read().startswith(b'\x89PNG')
        req=urllib.request.Request(origin+'/e/'+sid+'/api/me',headers={'Authorization':'Bearer '+viewer_token})
        with urllib.request.urlopen(req,context=context,timeout=20) as response:
            identity=json.load(response)
            assert set(identity['permissions'])=={'audio.listen','clipboard.read','desktop.view'} and identity['metadata']['expires_at_ms'] is None
        def bearer_status(token,path='/api/me'):
            request=urllib.request.Request(origin+'/e/'+sid+path,headers={'Authorization':'Bearer '+token})
            try:
                with urllib.request.urlopen(request,context=context,timeout=20) as response:return response.status
            except urllib.error.HTTPError as error:return error.code
        assert bearer_status(viewer_token,'/api/tokens')==403
        # Access changes revoke remotely without creating a replacement.
        api('/sessions/'+sid+'/access/'+viewer_user['id'],'PUT',{'role':'interactive'})
        wait(lambda:bearer_status(viewer_token)==401)
        with database(data) as db: assert db.execute("SELECT count(*) FROM instance_tokens WHERE kind='user' AND user_id=? AND session_id=?",[viewer_user['id'],sid]).fetchone()[0]==0
        replacement=viewer_account.connect(sid).split('#token=')[1]
        assert replacement!=viewer_token and bearer_status(replacement)==200
        api('/sessions/'+sid+'/access/'+viewer_user['id'],'PUT',{'role':'viewer'})
        wait(lambda:bearer_status(replacement)==401)
        viewer_token=viewer_account.connect(sid).split('#token=')[1]
        with database(data) as db: before_stop=list(db.execute('SELECT token_id,revoked FROM instance_tokens WHERE session_id=? ORDER BY token_id',[sid]))
        api('/sessions/'+sid+'/stop','POST')
        assert viewer_account.request('/sessions/'+sid+'/connect')[0]==409
        with database(data) as db: assert before_stop==list(db.execute('SELECT token_id,revoked FROM instance_tokens WHERE session_id=? ORDER BY token_id',[sid]))
        api('/sessions/'+sid+'/start','POST')
        wait(ready)
        assert account.connect(sid)==link and viewer_account.connect(sid).endswith(viewer_token)
        browser.append(dict(id=sid,distribution=distro,link=link,viewer=viewer_token,port=port))
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
