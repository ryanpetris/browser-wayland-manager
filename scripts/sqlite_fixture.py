"""SQLite fixtures initialized by the production migration runner."""
from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3
import subprocess
import time


@contextmanager
def database(data):
    connection = sqlite3.connect(Path(data) / 'state.sqlite3')
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys = ON')
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def seed(data, sessions, installation_id):
    env = dict(os.environ, INNKEEPER_DATA_DIR=str(data), INNKEEPER_LISTEN='127.0.0.1:0',
               INNKEEPER_IN_DOCKER='0', INNKEEPER_DOCKER_CONTAINER='', INNKEEPER_DOCKER_NETWORK='',
               INNKEEPER_TLS_CERT='', INNKEEPER_TLS_KEY='')
    process = subprocess.Popen(['elsewhere-innkeeper'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 15
        while True:
            if process.poll() is not None:
                raise AssertionError(process.stdout.read().decode())
            if (Path(data) / 'state.sqlite3').exists():
                try:
                    with database(data) as db:
                        if db.execute('SELECT installation_id FROM metadata').fetchone():
                            break
                except sqlite3.DatabaseError:
                    pass
            if time.monotonic() > deadline:
                raise AssertionError('Database initialization timed out')
            time.sleep(0.05)
    finally:
        process.terminate()
        process.communicate(timeout=10)
    with database(data) as db:
        db.execute('UPDATE metadata SET installation_id = ?', [installation_id])
        for s in sessions:
            db.execute('''INSERT INTO sessions
                (id,name,distribution,port,started_ms,status,stage,error,repair_available,upgrade_started_ms,gpu_access)
                VALUES (?,?,?,?,?,?,?,?,0,0,0)''',
                [s['id'], s['name'], s['distribution'], s['port'], s.get('started_ms', 0), s['status'], s['stage'], s.get('error')])
            for kind in ('desired', 'applied'):
                db.execute('INSERT INTO session_settings VALUES (?,?,NULL,NULL,0,?,1)', [s['id'], kind, ''])


def settings(data, sid, kind):
    with database(data) as db:
        row = db.execute('SELECT * FROM session_settings WHERE session_id = ? AND kind = ?', [sid, kind]).fetchone()
        if row is None:
            return None
        return dict(screen_size=None if row['width'] is None else dict(width=row['width'], height=row['height']),
                    kiosk=bool(row['kiosk']), startup_command=row['startup_command'], software_encoding=bool(row['software_encoding']))


def reject_updates(data, sid, enabled):
    with database(data) as db:
        if enabled:
            # Session IDs in this rig are generated UUIDs.
            db.execute("""CREATE TRIGGER fixture_write_failure BEFORE UPDATE ON sessions
                WHEN NEW.id = '%s' BEGIN SELECT RAISE(ABORT, 'Fixture database write failure'); END""" % sid)
        else:
            db.execute('DROP TRIGGER fixture_write_failure')
