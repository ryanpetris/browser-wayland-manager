#!/usr/bin/env python3
"""Fault-inject the Elsewhere API to verify durable retirement and in-memory retries."""
import http.server
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from auth_fixture import Client, PASSWORD

VIEWER=['audio.listen','clipboard.read','desktop.view']
ALL=['apps.launch','audio.listen','broadcasts.manage','camera.send','clipboard.read','clipboard.write','commands.execute','desktop.control','desktop.view','dragdrop.upload','files.browse','files.download','files.manage','files.upload','microphone.send','tokens.manage','server.manage']
with tempfile.TemporaryDirectory(prefix='innkeeper-sync-') as temporary:
    work=Path(temporary);data=work/'data';data.mkdir();tools=work/'bin';tools.mkdir()
    remote=work/'remote.sqlite3'
    with sqlite3.connect(remote) as db:db.execute('CREATE TABLE tokens(secret TEXT PRIMARY KEY, metadata TEXT NOT NULL)')
    def issue(label,permissions):
        secret=secrets.token_hex(32);meta=dict(id=str(uuid.uuid4()),label=label,created_at_ms=0,expires_at_ms=None,permissions=permissions)
        with sqlite3.connect(remote) as db:db.execute('INSERT INTO tokens VALUES(?,?)',[secret,json.dumps(meta)])
        return secret,meta
    def metadata(secret):
        with sqlite3.connect(remote) as db:row=db.execute('SELECT metadata FROM tokens WHERE secret=?',[secret]).fetchone()
        return json.loads(row[0]) if row else None
    deleting_fails=threading.Event();attempts=[]
    class Backend(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def reply(self,status,body=None):
            self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers()
            if body is not None:self.wfile.write(json.dumps(body).encode())
        def identity(self):
            meta=metadata(self.headers.get('Authorization','').removeprefix('Bearer '))
            if not meta:self.reply(401)
            return meta
        def do_GET(self):
            meta=self.identity()
            if not meta:return
            if self.path.endswith('/api/me'):self.reply(200,dict(metadata=meta,permissions=meta['permissions'],available_permissions=ALL,features={}))
            elif self.path.endswith('/api/tokens'):
                if 'tokens.manage' not in meta['permissions']:self.reply(403);return
                with sqlite3.connect(remote) as db:tokens=[json.loads(row[0]) for row in db.execute('SELECT metadata FROM tokens')]
                self.reply(200,dict(tokens=tokens))
            else:self.reply(200,[])
        def do_POST(self):
            meta=self.identity()
            if not meta:return
            if 'tokens.manage' not in meta['permissions']:self.reply(403);return
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            assert body['expires_at_ms'] is None
            secret,created=issue(body['label'],body['permissions']);self.reply(201,dict(token=secret,metadata=created))
        def do_DELETE(self):
            meta=self.identity()
            if not meta:return
            if 'tokens.manage' not in meta['permissions']:self.reply(403);return
            token_id=self.path.rsplit('/',1)[-1];attempts.append((token_id,time.monotonic()))
            if deleting_fails.is_set():self.reply(503);return
            with sqlite3.connect(remote) as db:changed=db.execute("DELETE FROM tokens WHERE json_extract(metadata,'$.id')=?",[token_id]).rowcount
            self.reply(204 if changed else 404)
    backend=http.server.ThreadingHTTPServer(('127.0.0.1',19500),Backend)
    threading.Thread(target=backend.serve_forever,daemon=True).start()
    wrapper=tools/'docker'
    wrapper.write_text('''#!/usr/bin/python3
import sys,os,json,sqlite3,secrets,uuid
args=sys.argv[1:]
if args[0]=='inspect':
    with sqlite3.connect(os.environ['INNKEEPER_DATA_DIR']+'/state.sqlite3') as db:installation=db.execute('SELECT installation_id FROM metadata').fetchone()[0]
    print(json.dumps([{'Config':{'Labels':{'io.innkeeper.installation':installation}},'State':{'Running':True,'Status':'running'}}]))
elif args[0]=='exec' and args[-4:]==['elsewhere','token','create','--admin']:
    secret=secrets.token_hex(32);meta=dict(id=str(uuid.uuid4()),label='Admin',created_at_ms=0,expires_at_ms=None,permissions=json.loads(os.environ['FIXTURE_PERMISSIONS']))
    with sqlite3.connect(os.environ['FIXTURE_REMOTE']) as db:db.execute('INSERT INTO tokens VALUES(?,?)',[secret,json.dumps(meta)])
    print(secret)
else:sys.exit(1)
''');wrapper.chmod(0o755)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    env=dict(os.environ,PATH=str(tools)+':'+os.environ['PATH'],FIXTURE_REMOTE=str(remote),FIXTURE_PERMISSIONS=json.dumps(ALL),INNKEEPER_DATA_DIR=str(data),INNKEEPER_TLS='1',INNKEEPER_TLS_CERT='',INNKEEPER_TLS_KEY='',INNKEEPER_IN_DOCKER='0',INNKEEPER_DOCKER_CONTAINER='',INNKEEPER_DOCKER_NETWORK='',INNKEEPER_LISTEN=f'127.0.0.1:{port}')
    env.pop('INNKEEPER_LOCAL_ELSEWHERE',None)
    binary=os.environ.get('INNKEEPER_BINARY','elsewhere-innkeeper');log=tempfile.TemporaryFile();process=None
    def start():return subprocess.Popen([binary],env=env,stdout=log,stderr=log)
    def wait(test,timeout=20):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:
                if test():return
            except (OSError,ConnectionError):pass
            assert process.poll() is None,'Innkeeper exited'
            time.sleep(.1)
        raise AssertionError('Timed out')
    def rows():
        with sqlite3.connect(data/'state.sqlite3') as db:return db.execute('SELECT token_id,kind,user_id,revoked FROM instance_tokens').fetchall()
    def count_attempts(token_id):return len([t for t,_ in attempts if t==token_id])
    try:
        process=start();admin=Client(f'https://127.0.0.1:{port}');wait(lambda:admin.request('/setup')[0]==200);admin.setup()
        user=admin.api('/users','POST',dict(username='shared',display_name='Shared user',password=PASSWORD))['user'];client=Client(admin.origin);client.login('shared')
        sid=str(uuid.uuid4())
        with sqlite3.connect(data/'state.sqlite3') as db:
            db.execute("INSERT INTO sessions(id,name,distribution,port,started_ms,status,stage,repair_available,upgrade_started_ms) VALUES(?,'Fixture','debian',19500,0,'running','ready',0,0)",[sid])
            db.execute("INSERT INTO session_settings VALUES(?,'desired',NULL,NULL,0,'')",[sid])
        access=f'/sessions/{sid}/access/{user["id"]}'
        admin.api(access,'PUT',{'role':'viewer'});wait(lambda:len(rows())==1)
        assert rows()[0][1]=='internal'
        assert client.request(f'/sessions/{sid}/connect')[0]==200 and len(rows())==1
        old=client.connect(sid).split('#token=')[1];old_id=metadata(old)['id'];assert client.connect(sid).endswith(old)
        deleting_fails.set();admin.api(access,'PUT',{'role':'interactive'});wait(lambda:count_attempts(old_id)==1)
        assert next(row for row in rows() if row[0]==old_id)[3]==1
        admin.api(access,'PUT',{'role':'viewer'})
        fresh=client.connect(sid).split('#token=')[1];assert fresh!=old and metadata(old) is not None
        assert count_attempts(old_id)==1
        for _ in range(3):assert client.connect(sid).endswith(fresh)
        assert count_attempts(old_id)==1
        wait(lambda:count_attempts(old_id)==2,10)
        times=[t for token,t in attempts if token==old_id];assert 4.9<=times[1]-times[0]<8,times
        # Restart forgets the old ten-second deadline but retains the irreversible marker.
        process.terminate();process.wait(timeout=10);deleting_fails.clear();started=time.monotonic();process=start()
        wait(lambda:metadata(old) is None)
        assert time.monotonic()-started<8
        wait(lambda:all(row[0]!=old_id for row in rows()))
        assert client.connect(sid).endswith(fresh)
        # Lost creation responses are discovered by exact labels, including internal Admin tokens.
        orphan,orphan_meta=issue('Innkeeper user '+user['id'],VIEWER)
        orphan_admin,orphan_admin_meta=issue('Admin',ALL)
        admin.api(access,'PUT',{'role':'viewer'})
        wait(lambda:metadata(orphan) is None and metadata(orphan_admin) is None)
        wait(lambda:all(row[0] not in (orphan_meta['id'],orphan_admin_meta['id']) for row in rows()))
        # Losing access retires tokens but creates no replacement.
        admin.api(access,'DELETE');wait(lambda:metadata(fresh) is None)
        assert client.request(f'/sessions/{sid}/connect')[0]==404
        wait(lambda:all(row[1]=='internal' for row in rows()))
        print('PASS: lazy issuance, irreversible retirement, concurrent connect/retry isolation, five-second backoff, restart retry, orphan cleanup, no-access revocation')
    finally:
        if process and process.poll() is None:process.terminate();process.wait(timeout=10)
        backend.shutdown();log.close()
