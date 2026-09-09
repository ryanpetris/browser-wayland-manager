#!/usr/bin/env python3
"""Run as a non-root user in Docker. Exercise orchestration without a Docker socket."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='innkeeper-local-check-') as temporary:
    work = Path(temporary)
    root = work / 'innkeeper with spaces'
    root.mkdir()
    (root / 'scripts').mkdir()
    shutil.copyfile(SOURCE / 'elsewhere-local.py', root / 'scripts/elsewhere-local.py')
    (root / '.gitignore').write_text('/.elsewhere-local/\n')
    (root / 'scripts/elsewhere-local.Dockerfile').write_text('FROM scratch\n')
    (root / 'compose.yaml').write_text('services: {}\n')
    subprocess.run(['git', 'init', '-q', str(root)], check=True)
    bins = work / 'bin'
    bins.mkdir()
    docker = bins / 'docker'
    docker.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as log: log.write(json.dumps(a) + '\\n')
if a[0] in ('build', 'compose'): sys.exit(0)
source = Path(a[a.index('--workdir') + 1])
version = (source / 'version').read_text().strip().removeprefix('v').replace('-', '.')
if 'make' in a:
    for relative in ('target', 'web/node_modules', 'web/dist'):
        directory = source / relative
        assert directory.is_dir() and directory.stat().st_uid == os.getuid()
    if os.environ.get('NO_OUTPUT'): sys.exit(0)
    distro = a[-1]
    if distro == 'package-deb' and os.environ.get('FAIL_DEBIAN'): sys.exit(7)
    archive = ('elsewhere-' + version + '-1-x86_64.pkg.tar.zst' if distro == 'package-arch'
               else 'elsewhere_' + version + '-1_debian-13_amd64.deb')
    (source / 'dist').mkdir(exist_ok=True)
    (source / 'dist' / archive).write_text(distro)
    if os.environ.get('CHANGE_SOURCE'): (source / ' input').write_text('changed')
elif 'bsdtar' in a:
    print('pkgname = elsewhere\\npkgver = ' + version + '-1\\narch = x86_64')
elif 'dpkg-deb' in a:
    print('Package: elsewhere\\nVersion: ' + ('99.0.0' if os.environ.get('BAD_METADATA') else version)
          + '-1\\nArchitecture: amd64')
else: sys.exit(8)
''')
    docker.chmod(0o755)
    env = dict(os.environ, PATH=str(bins) + ':' + os.environ['PATH'], CALLS=str(work / 'calls'))
    def invoke(action='build', success=True, **extra):
        result = subprocess.run(['python3', str(root / 'scripts/elsewhere-local.py'), action],
                                env=dict(env, **extra), capture_output=True, text=True)
        assert (result.returncode == 0) == success, result.stdout + result.stderr
        return result.stdout + result.stderr
    assert 'does not exist' in invoke(success=False)
    assert not (root / '.elsewhere-local').exists()
    checkout = work / 'elsewhere'
    (checkout / 'scripts').mkdir(parents=True)
    (checkout / 'scripts/package.sh').write_text('fixture')
    (checkout / 'version').write_text('v0.4.4.7-dirty\n')
    (checkout / 'Makefile').write_text('.PHONY: version\nversion:\n\t@cat version\n')
    (checkout / ' input').write_text('original')
    (checkout / '.gitignore').write_text('/dist/\n/target/\n')
    subprocess.run(['git', 'init', '-q', str(checkout)], check=True)
    subprocess.run(['git', '-C', str(checkout), 'add', '.'], check=True)
    subprocess.run(['git', '-C', str(checkout), '-c', 'user.name=Fixture',
                    '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'], check=True)
    invoke()
    local = root / '.elsewhere-local'
    manifest = local / 'manifest.json'
    original = manifest.read_bytes()
    selected = json.loads(original)
    assert selected['version'] == '0.4.4.7.dirty'
    assert len(list((local / selected['directory']).iterdir())) == 2
    assert (local / selected['directory'] / 'elsewhere_0.4.4.7.dirty-1_debian-13_amd64.deb').is_file()
    assert 'type=bind' in (work / 'calls').read_text()
    compose = json.loads((local / 'compose.json').read_text())
    assert compose['services']['innkeeper']['volumes'][0]['read_only'] is True
    for failure in ('FAIL_DEBIAN', 'BAD_METADATA', 'CHANGE_SOURCE'):
        invoke(success=False, **{failure: '1'})
        assert manifest.read_bytes() == original
        assert len(list(local.glob('build-*'))) == 1
    invoke(success=False, NO_OUTPUT='1')
    assert manifest.read_bytes() == original
    assert len(list(local.glob('build-*'))) == 1
    with (local / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        assert 'Another local-build operation' in invoke('reset', success=False)
        assert manifest.read_bytes() == original
    (root / '.gitignore').write_text('')
    assert 'must be ignored' in invoke('reset', success=False)
    (root / '.gitignore').write_text('/.elsewhere-local/\n')
    subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
    tracked = subprocess.check_output(['git', '-C', str(root), 'ls-files'], text=True)
    assert '.elsewhere-local/' not in tracked
    invoke('run')
    assert json.loads((work / 'calls').read_text().splitlines()[-1])[-4:] == ['up', '-d', '--build', '--force-recreate']
    invoke('reset')
    assert not manifest.exists() and not (local / 'compose.json').exists()
    assert (local / selected['directory']).exists()
    invoke('run', success=False)
    print('Missing checkout, sequential builds, metadata validation, source mutation, stale output, atomic selection, lock contention, ignored files, explicit Compose and reset passed')
