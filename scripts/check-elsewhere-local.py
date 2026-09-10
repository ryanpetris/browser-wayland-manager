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
if a[0] == 'compose':
    if a[-2:] == ['config', '--images']: print('innkeeper-local-fixture')
    sys.exit(0)
if a[:2] == ['buildx', 'bake']:
    targets = json.load(sys.stdin)['target']
    assert set(targets) == {'innkeeper', 'arch', 'debian'}
    assert targets['innkeeper']['tags'] == ['innkeeper-local-fixture']
    assert a[-3:] == ['innkeeper', 'arch', 'debian']
    assert targets['innkeeper']['output'] == ['type=docker']
    assert '--allow=fs.read=' + targets['arch']['context'] in a
    if os.environ.get('FAIL_BAKE'): sys.exit(7)
    for distro in ('arch', 'debian'):
        target = targets[distro]
        assert target['target'] == distro
        assert target['platforms'] == ['linux/amd64']
        assert Path(target['context']).name == 'elsewhere'
        assert Path(target['dockerfile']).name == 'elsewhere-local.Dockerfile'
        version = target['args']['ELSEWHERE_VERSION'].removeprefix('v').replace('-', '.')
        if distro == 'debian' and os.environ.get('FAIL_DEBIAN'): sys.exit(7)
        if os.environ.get('NO_OUTPUT'): continue
        destination = target['output'][0]
        assert destination['type'] == 'local'
        directory = Path(destination['dest'])
        directory.mkdir(parents=True)
        archive = ('elsewhere-' + version + '-1-x86_64.pkg.tar.zst' if distro == 'arch'
                   else 'elsewhere_' + version + '-1_debian-13_amd64.deb')
        (directory / archive).write_text(distro)
    sys.exit(0)
else: sys.exit(8)
''')
    docker.chmod(0o755)
    env = dict(os.environ, PATH=str(bins) + ':' + os.environ['PATH'], CALLS=str(work / 'calls'))
    def invoke(action='local', success=True, **extra):
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
    compose = json.loads((local / 'compose.json').read_text())
    assert compose['services']['innkeeper']['volumes'][0]['read_only'] is True
    calls = lambda: [json.loads(line) for line in (work / 'calls').read_text().splitlines()]
    assert calls()[-1][-4:] == ['up', '-d', '--no-build', '--force-recreate']
    activations = lambda: sum('up' in call for call in calls())
    assert activations() == 1
    for failure in ('FAIL_BAKE', 'FAIL_DEBIAN'):
        invoke(success=False, **{failure: '1'})
        assert manifest.read_bytes() == original
        assert activations() == 1
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
    invoke()
    assert activations() == 2
    assert json.loads(manifest.read_text())['directory'] != selected['directory']
    invoke('reset')
    assert not manifest.exists() and not (local / 'compose.json').exists()
    assert (local / selected['directory']).exists()
    print('Missing checkout, Bake package exports, missing output, atomic selection, lock contention, ignored files, automatic Compose activation and reset passed')
