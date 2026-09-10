#!/usr/bin/env python3
"""Build adjacent Elsewhere packages and run Innkeeper with them."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.elsewhere-local'
SOURCE = (ROOT.parent / 'elsewhere').resolve()


def run(*args, **kwargs):
    try:
        return subprocess.run([str(arg) for arg in args], check=True, **kwargs)
    except FileNotFoundError as error:
        raise RuntimeError(f'Required command is not available: {args[0]}') from error


def output(*args, **kwargs):
    return run(*args, stdout=subprocess.PIPE, text=True, **kwargs).stdout.strip()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    try:
        with temporary.open('w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def build():
    if not (SOURCE / 'Makefile').is_file() or not (SOURCE / 'scripts/package.sh').is_file():
        raise RuntimeError('Adjacent elsewhere checkout is missing or lacks its package targets. Nothing was checked out.')
    if output('git', '-C', SOURCE, 'rev-parse', '--show-toplevel') != str(SOURCE):
        raise RuntimeError('The adjacent elsewhere directory must be the checkout root.')
    git_version = output('make', '--no-print-directory', '-s', '-C', SOURCE, 'version',
                         env=dict(os.environ, GIT_OPTIONAL_LOCKS='0'))
    version = git_version.removeprefix('v').replace('-', '.')
    parts = version.removesuffix('.dirty').split('.')
    if len(parts) < 3 or not all(part.isascii() and part.isdigit() for part in parts):
        raise RuntimeError('Elsewhere returned an unsupported package version.')
    compose_image = output('docker', 'compose', '--project-directory', ROOT,
                           '-f', ROOT / 'compose.yaml', 'config', '--images')
    generation = Path(tempfile.mkdtemp(prefix='build-', dir=LOCAL))
    publishing = False
    try:
        targets = {'innkeeper': {'tags': [compose_image], 'output': ['type=docker']}}
        for distro in ('arch', 'debian', 'ubuntu'):
            targets[distro] = {
                'context': str(SOURCE),
                'dockerfile': str(ROOT / 'scripts/elsewhere-local.Dockerfile'),
                'target': distro,
                'platforms': ['linux/amd64'],
                'args': {'ELSEWHERE_VERSION': git_version},
                'output': [{'type': 'local', 'dest': str(generation / distro)}],
            }
        run('docker', 'buildx', 'bake', f'--allow=fs.read={SOURCE}',
            f'--allow=fs.write={generation}', '-f', ROOT / 'compose.yaml', '-f', '-',
            *targets, input=json.dumps({'target': targets}), text=True, cwd=ROOT)
        for distro, asset in (
            ('arch', f'elsewhere-{version}-1-x86_64.pkg.tar.zst'),
            ('debian', f'elsewhere_{version}-1_debian-13_amd64.deb'),
            ('ubuntu', f'elsewhere_{version}-1_ubuntu-26.04_amd64.deb')):
            archive = generation / distro / asset
            if not archive.is_file() or not archive.stat().st_size:
                raise RuntimeError(f'Expected package was not produced: {archive.name}')
            archive.rename(generation / asset)
            (generation / distro).rmdir()
            with (generation / asset).open('rb') as stream:
                os.fsync(stream.fileno())
        sync_directory(generation)
        compose = {'services': {'innkeeper': {
            'environment': {'INNKEEPER_LOCAL_ELSEWHERE': '/run/innkeeper-local/manifest.json'},
            'volumes': [{'type': 'bind', 'source': str(LOCAL).replace('$', '$$'),
                         'target': '/run/innkeeper-local', 'read_only': True}]}}}
        atomic_json(LOCAL / 'compose.json', compose)
        # Keep artifacts once publication starts, even if its durability check fails.
        publishing = True
        atomic_json(LOCAL / 'manifest.json', {'version': version, 'directory': generation.name})
        print(f'Local Elsewhere {version} is ready.')
    except BaseException:
        if not publishing:
            shutil.rmtree(generation)
        raise


def main():
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action not in ('local', 'reset'):
        raise RuntimeError('Expected local or reset')
    # Check the checkout before creating any local build state.
    if action == 'local' and not SOURCE.is_dir():
        raise RuntimeError('Adjacent elsewhere checkout does not exist. Nothing was checked out.')
    if os.getuid() == 0:
        raise RuntimeError('Run local-build commands as a non-root user so exported packages belong to you.')
    LOCAL.mkdir(exist_ok=True)
    if output('git', '-C', ROOT, 'ls-files', '--', '.elsewhere-local'):
        raise RuntimeError('.elsewhere-local contains tracked files; refusing to write an override.')
    if subprocess.run(['git', '-C', str(ROOT), 'check-ignore', '-q', '.elsewhere-local/manifest.json']).returncode:
        raise RuntimeError('Local overrides must be ignored by Git. Restore /.elsewhere-local/ in .gitignore.')
    with (LOCAL / 'lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another local-build operation is running. Retry after it finishes.') from error
        if action == 'local':
            build()
            run('docker', 'compose', '--project-directory', ROOT, '-f', ROOT / 'compose.yaml',
                '-f', LOCAL / 'compose.json', 'up', '-d', '--no-build', '--force-recreate')
        else:
            (LOCAL / 'manifest.json').unlink(missing_ok=True)
            (LOCAL / 'compose.json').unlink(missing_ok=True)
            print('Local selection cleared. Use normal Docker Compose to return to the release pin. Staged packages are retained.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(f'elsewhere-local: {error}', file=sys.stderr)
        sys.exit(1)
