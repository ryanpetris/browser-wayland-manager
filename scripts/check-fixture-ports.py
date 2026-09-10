#!/usr/bin/env python3
"""Check desktop port reservations against the Docker daemon."""
from contextlib import redirect_stderr
import io
import os
import subprocess
from unittest.mock import patch
from sqlite_fixture import docker_ports

created = []
original = subprocess.check_output
try:
    for port in (19998, 19999):
        created.append(original(['docker', 'create', '--publish', f'{port}:{port}/udp', 'debian:trixie-slim', 'true'], text=True).strip())
    def disappear(command, *args, **kwargs):
        result = original(command, *args, **kwargs)
        if command == ['docker', 'ps', '-aq']:
            subprocess.run(['docker', 'rm', created[0]], check=True, stdout=subprocess.DEVNULL)
        return result
    with patch.object(subprocess, 'check_output', side_effect=disappear):
        assert 19999 in docker_ports()
    with patch.object(subprocess, 'check_output', return_value=created[0]):
        assert docker_ports() == set()
    with patch.object(subprocess, 'check_output', return_value=''):
        assert docker_ports() == set()
    diagnostic = io.StringIO()
    with redirect_stderr(diagnostic), patch.object(subprocess, 'check_output', return_value=created[1]), patch.dict(os.environ, DOCKER_HOST='unix:///nonexistent-fixture.sock', DOCKER_CONTEXT=''):
        try:
            docker_ports()
        except subprocess.CalledProcessError as error:
            assert 'Cannot connect to the Docker daemon' in error.stderr, error.stderr
        else:
            raise AssertionError('Disconnected Docker daemon was ignored')
    assert 'Cannot connect to the Docker daemon' in diagnostic.getvalue()
    for error in ('permission denied', 'Error: No such object: unlisted'):
        failure = subprocess.CompletedProcess(['docker', 'inspect', 'listed'], 1, '[]', error + '\n')
        with redirect_stderr(io.StringIO()), patch.object(subprocess, 'check_output', return_value='listed'), patch.object(subprocess, 'run', return_value=failure):
            try:
                docker_ports()
            except subprocess.CalledProcessError:
                pass
            else:
                raise AssertionError('Docker failure was ignored')
    print('PASS: disappearing containers, retained ports, empty discovery and genuine Docker failures')
finally:
    for cid in created:
        subprocess.run(['docker', 'rm', '-f', cid], capture_output=True)
