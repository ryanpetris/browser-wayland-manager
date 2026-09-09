#!/usr/bin/env python3
"""Exercise accounts, login expiry, and sharing in the Docker image."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import uuid
from auth_fixture import Client, PASSWORD

with tempfile.TemporaryDirectory(prefix='innkeeper-accounts-') as temporary:
    data=Path(temporary)/'data'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    env=dict(os.environ,INNKEEPER_DATA_DIR=str(data),INNKEEPER_IN_DOCKER='0',INNKEEPER_DOCKER_CONTAINER='',INNKEEPER_DOCKER_NETWORK='',INNKEEPER_TLS='1',INNKEEPER_TLS_CERT='',INNKEEPER_TLS_KEY='',INNKEEPER_LISTEN=f'127.0.0.1:{port}')
    env.pop('INNKEEPER_LOCAL_ELSEWHERE',None)
    log=tempfile.TemporaryFile()
    process=subprocess.Popen([os.environ.get('INNKEEPER_BINARY','elsewhere-innkeeper')],env=env,stdout=log,stderr=log)
    def db():
        connection=sqlite3.connect(data/'state.sqlite3');connection.execute('PRAGMA foreign_keys=ON');return connection
    a=Client(f'https://127.0.0.1:{port}')
    try:
        for _ in range(100):
            try:
                assert a.api('/setup')['required'];break
            except (ConnectionError,OSError):time.sleep(.1)
        assert a.request('/me')[0]==401
        assert a.request('/setup','POST',dict(username='custom',display_name='First',password=PASSWORD),{'Origin':'https://foreign.invalid'})[0]==403
        candidates=[Client(a.origin),Client(a.origin)]
        with concurrent.futures.ThreadPoolExecutor() as pool:
            results=list(pool.map(lambda c:c.request('/setup','POST',dict(username='fixture',display_name='First',password=PASSWORD)),candidates))
        assert sorted(r[0] for r in results)==[201,409],results
        a=candidates[next(i for i,r in enumerate(results) if r[0]==201)]
        admin=a.api('/me')['user'];assert uuid.UUID(admin['id']).version==4
        assert not a.api('/setup')['required']
        assert a.request('/setup','POST',dict(username='other',display_name='Other',password=PASSWORD))[0]==409
        cookie=results[next(i for i,r in enumerate(results) if r[0]==201)][1]
        cookie=next(v for k,v in cookie.items() if k.lower()=='set-cookie')
        assert all(v in cookie.lower() for v in ('httponly','secure','samesite=strict','path=/api'))
        assert 'set-cookie' not in {k.lower() for k in a.request('/me')[1]}
        u=a.api('/users','POST',dict(username='Person',display_name='A person',password=PASSWORD))['user']
        assert u['username']=='person' and 'password_hash' not in u
        assert a.request('/users','POST',dict(username='PERSON',display_name='Duplicate',password=PASSWORD))[0]==409
        assert a.request('/users','POST',dict(username='email',display_name='Email',password=PASSWORD,email='not-accepted'))[0]==400
        with db() as conn:
            hashes=[r[0] for r in conn.execute('SELECT password_hash FROM users')]
        assert len(set(hashes))==2 and all(h.startswith('$argon2id$v=19$m=19456,t=2,p=1$') for h in hashes)
        viewer=Client(a.origin);viewer.login('person')
        assert viewer.request('/users')[0]==403
        assert viewer.request('/me','PATCH',{'username':'changed'})[0]==400
        assert viewer.api('/me','PATCH',{'display_name':'New display'})['user']['display_name']=='New display'
        assert a.request('/users/'+admin['id'],'PATCH',{'role':'user'})[0]==409
        assert a.request('/users/'+admin['id'],'DELETE')[0]==409
        assert a.request('/users','POST',{}, {'X-Innkeeper-CSRF':'bad'})[0]==403
        session=a.api('/sessions','POST',dict(name='Machine',distribution='debian',packages=[]))
        sid=session['id'];assert session['access_role']=='manager'
        assert not viewer.api('/sessions')['sessions']
        assert viewer.request(f'/sessions/{sid}/logs')[0]==404
        a.api(f'/sessions/{sid}/access/{u["id"]}','PUT',{'role':'viewer'})
        visible=viewer.api('/sessions')['sessions'][0]
        assert visible['access_role']=='viewer' and 'docker_args' not in visible and 'startup_command' not in visible
        for action in ('start','stop','relaunch','upgrade'):
            assert viewer.request(f'/sessions/{sid}/{action}','POST')[0]==403
        assert viewer.request(f'/sessions/{sid}/access')[0]==403
        assert viewer.request('/sessions','POST',dict(name='Denied',distribution='debian',packages=[],docker_args=['--cap-add=SYS_ADMIN']))[0]==403
        # A role change retires mismatched credentials atomically. Restoring grants never unmarks them.
        token_id=str(uuid.uuid4())
        with db() as conn:
            conn.execute("INSERT INTO instance_tokens VALUES(?,?,'user',?, ?,0)",(sid,token_id,u['id'],'a'*64))
            for p in ('audio.listen','clipboard.read','desktop.view'):
                conn.execute('INSERT INTO instance_token_permissions VALUES(?,?,?)',(sid,token_id,p))
        a.api(f'/sessions/{sid}/access/{u["id"]}','PUT',{'role':'interactive'})
        with db() as conn: assert conn.execute('SELECT revoked FROM instance_tokens WHERE token_id=?',(token_id,)).fetchone()[0]==1
        a.api(f'/sessions/{sid}/access/{u["id"]}','PUT',{'role':'viewer'})
        with db() as conn: assert conn.execute('SELECT revoked FROM instance_tokens WHERE token_id=?',(token_id,)).fetchone()[0]==1
        a.api('/users/'+u['id'],'PATCH',{'username':'renamed'})
        assert viewer.api('/me')['user']['id']==u['id']
        # Force the current login into its renewal window, then race two tabs.
        cookie_id=viewer.cookie.split('=',1)[1];digest=hashlib.sha256(cookie_id.encode()).digest()
        with db() as conn: conn.execute('UPDATE login_sessions SET expires_at_unix_seconds=?,expires_at_nanosecond=123456789 WHERE secret_hash=?',(int(time.time())+3600,digest))
        second=Client(a.origin);second.cookie=viewer.cookie;second.csrf=viewer.csrf
        with concurrent.futures.ThreadPoolExecutor() as pool: renewals=list(pool.map(lambda c:c.request('/session/renew','POST'),[viewer,second]))
        assert all(r[0]==200 for r in renewals),renewals
        assert abs(renewals[0][2]['session_expires_at_ms']-renewals[1][2]['session_expires_at_ms'])<1
        assert sum(any(k.lower()=='set-cookie' for k in r[1]) for r in renewals)==1
        before=viewer.api('/me')['session_expires_at_ms'];assert viewer.api('/session/renew','POST')['session_expires_at_ms']==before
        a.api('/users/'+u['id']+'/password','PUT',{'password':'a completely different password'})
        assert viewer.request('/me')[0]==401 and second.request('/session/renew','POST')[0]==401
        viewer.login('renamed','a completely different password')
        a.api('/users/'+u['id'],'DELETE')
        assert viewer.request('/me')[0]==401
        with db() as conn:
            assert conn.execute('SELECT user_id,revoked FROM instance_tokens WHERE token_id=?',(token_id,)).fetchone()==(None,1)
            assert conn.execute('SELECT count(*) FROM sessions WHERE id=?',(sid,)).fetchone()[0]==1
        wrong=Client(a.origin)
        assert [wrong.request('/login','POST',dict(username='missing',password=PASSWORD))[0] for _ in range(6)]==[401]*5+[429]
        a.api('/logout','POST');assert a.request('/me')[0]==401
        print('PASS: setup races, UUID accounts, salted hashes, CSRF, roles, sharing, renewal, revocation markers, password resets, logout, login limits')
    finally:
        process.terminate();process.wait(timeout=10)
        log.seek(0)
        if process.returncode not in (0,-15): print(log.read().decode())
