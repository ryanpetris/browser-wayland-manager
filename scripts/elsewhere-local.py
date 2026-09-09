#!/usr/bin/env python3
"""Build adjacent Elsewhere packages and select them for an explicit local Compose run."""
import fcntl
import hashlib
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


def snapshot():
    digest = hashlib.sha256(output('git', '-C', SOURCE, 'rev-parse', 'HEAD').encode())
    names = run('git', '-C', SOURCE, 'ls-files', '-co', '--exclude-standard', '-z',
                stdout=subprocess.PIPE, text=True).stdout
    for name in sorted(set(names.split('\0')) - {''}):
        path = SOURCE / name
        digest.update(name.encode() + b'\0')
        if path.is_symlink():
            digest.update(b'link\0' + os.readlink(path).encode())
        elif path.is_file():
            digest.update(str(path.stat().st_mode).encode() + b'\0')
            with path.open('rb') as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
        else:
            digest.update(b'missing\0')
    return digest.digest()


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
    original = snapshot()
    git_version = output('make', '--no-print-directory', '-s', '-C', SOURCE, 'version')
    version = git_version.removeprefix('v').replace('-', '.')
    parts = version.removesuffix('.dirty').split('.')
    if len(parts) < 3 or not all(part.isascii() and part.isdigit() for part in parts):
        raise RuntimeError('Elsewhere returned an unsupported package version.')
    generation = Path(tempfile.mkdtemp(prefix='build-', dir=LOCAL))
    publishing = False
    try:
        for distro, target, asset in (
            ('arch', 'package-arch', f'elsewhere-{version}-1-x86_64.pkg.tar.zst'),
            ('debian', 'package-deb', f'elsewhere_{version}-1_debian-13_amd64.deb')):
            image = f'innkeeper-elsewhere-build:{distro}'
            run('docker', 'build', '--platform', 'linux/amd64', '--target', distro, '-t', image,
                '--build-arg', f'BUILDER_UID={os.getuid()}',
                '--build-arg', f'BUILDER_GID={os.getgid()}',
                '-f', ROOT / 'scripts/elsewhere-local.Dockerfile', ROOT / 'scripts')
            cache = LOCAL / 'cache' / distro
            for directory in ('target', 'cargo', 'node_modules', 'web-dist'):
                (cache / directory).mkdir(parents=True, exist_ok=True)
            for mount in (SOURCE / 'target', SOURCE / 'web/node_modules', SOURCE / 'web/dist'):
                mount.mkdir(parents=True, exist_ok=True)
            command = ['docker', 'run', '--rm', '--platform', 'linux/amd64',
                       '--env', 'GIT_OPTIONAL_LOCKS=0', '--workdir', str(SOURCE),
                       '--mount', f'type=bind,src={SOURCE},dst={SOURCE}',
                       '--mount', f'type=bind,src={cache / "target"},dst={SOURCE / "target"}',
                       '--mount', f'type=bind,src={cache / "cargo"},dst=/cargo-cache',
                       '--mount', f'type=bind,src={cache / "node_modules"},dst={SOURCE / "web/node_modules"}',
                       '--mount', f'type=bind,src={cache / "web-dist"},dst={SOURCE / "web/dist"}']
            git_dir = Path(output('git', '-C', SOURCE, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
            if not git_dir.is_relative_to(SOURCE):
                command += ['--mount', f'type=bind,src={git_dir},dst={git_dir},readonly']
            archive = SOURCE / 'dist' / (f'elsewhere_{version}-1_debian-13_amd64.deb'
                                        if distro == 'debian' else asset)
            archive.unlink(missing_ok=True)
            run(*command, image, 'make', target)
            if snapshot() != original or output('make', '--no-print-directory', '-s', '-C', SOURCE, 'version') != git_version:
                raise RuntimeError('Elsewhere source changed during the build. Retry after changes are finished.')
            if not archive.is_file() or not archive.stat().st_size:
                raise RuntimeError(f'Expected package was not produced: {archive.name}')
            if distro == 'arch':
                metadata = output(*command, image, 'bsdtar', '-xOf', archive, '.PKGINFO')
                fields = dict(line.split(' = ', 1) for line in metadata.splitlines() if ' = ' in line)
                actual = (fields.get('pkgname'), fields.get('pkgver'), fields.get('arch'))
                expected = ('elsewhere', version + '-1', 'x86_64')
            else:
                metadata = output(*command, image, 'dpkg-deb', '-f', archive, 'Package', 'Version', 'Architecture')
                fields = dict(line.split(': ', 1) for line in metadata.splitlines() if ': ' in line)
                actual = (fields.get('Package'), fields.get('Version'), fields.get('Architecture'))
                expected = ('elsewhere', version + '-1', 'amd64')
            if actual != expected:
                raise RuntimeError(f'{distro} package metadata does not match the requested build: {actual}')
            shutil.copyfile(archive, generation / asset)
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
        print(f'Local Elsewhere {version} is ready. Run make run-local to activate it.')
    except BaseException:
        if not publishing:
            shutil.rmtree(generation)
        raise


def main():
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action not in ('build', 'run', 'reset'):
        raise RuntimeError('Expected build, run, or reset')
    # Check the checkout before creating any local build state.
    if action == 'build' and not SOURCE.is_dir():
        raise RuntimeError('Adjacent elsewhere checkout does not exist. Nothing was checked out.')
    if os.getuid() == 0:
        raise RuntimeError('Run local-build commands as a non-root user; Arch makepkg requires it.')
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
        if action == 'build':
            build()
        elif action == 'run':
            if not (LOCAL / 'manifest.json').is_file() or not (LOCAL / 'compose.json').is_file():
                raise RuntimeError('No local packages selected. Run make elsewhere-local first.')
            run('docker', 'compose', '--project-directory', ROOT, '-f', ROOT / 'compose.yaml',
                '-f', LOCAL / 'compose.json', 'up', '-d', '--build', '--force-recreate')
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
