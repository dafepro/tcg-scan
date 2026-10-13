#!/usr/bin/env python3
"""Fetch the source-pinned public numeric pack for an explicit release build."""
import hashlib
import json
import re
import stat
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
MAX_FILE = 25 * 1024 * 1024
ARCHIVE_NOTICES = {'COVERAGE.json', 'INSTALL.txt', 'LICENSES/TCGDEX-DATABASE-MIT.txt',
                   'LICENSES/XFEAT-APACHE-2.0.txt', 'LICENSES/XFEAT-NOTICE.txt',
                   'PROVENANCE.json', 'README.txt', 'RIGHTS-NOTICE.txt', 'SHA256SUMS'}


def read_pins():
    text = (ROOT/'src/lib/pokemon-reference-release.ts').read_text()
    body = re.search(r'export const POKEMON_REFERENCE_RELEASE\s*=\s*\{([\s\S]*?)\}\s*as const;', text).group(1)
    pins = {}
    for name in ('url', 'sha256', 'manifestSha256'):
        matches = re.findall(r'\b' + name + r':\s*"([^"]+)"', body)
        if len(matches) != 1:
            raise ValueError('Missing or ambiguous release pin')
        pins[name] = matches[0]
    for name in ('sizeBytes', 'referenceBytes', 'manifestBytes', 'shardCount'):
        matches = re.findall(r'\b' + name + r':\s*([0-9][0-9_]*)(?=\s*[,}])', body)
        if len(matches) != 1:
            raise ValueError('Missing or ambiguous release size')
        pins[name] = int(matches[0].replace('_', ''))
    if (not pins['url'].startswith('https://github.com/dafepro/tcg-scan/releases/download/')
            or any(not re.fullmatch('[0-9a-f]{64}', pins[name]) for name in ('sha256', 'manifestSha256'))
            or not 0 < pins['sizeBytes'] <= 512 * 1024 * 1024
            or not 0 < pins['referenceBytes'] <= 512 * 1024 * 1024
            or not 0 < pins['manifestBytes'] <= MAX_FILE or not 0 < pins['shardCount'] < 1000):
        raise ValueError('Reference pins violate the supported build contract')
    return pins


class PublicReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        target = urllib.parse.urlsplit(url)
        if target.scheme != 'https' or target.hostname not in {
                'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}:
            raise ValueError('Unexpected public release redirect')
        return super().redirect_request(request, response, code, message, headers, url)


def extract_reference(archive_path, destination, pins):
    if archive_path.stat().st_size != pins['sizeBytes']:
        raise ValueError('Reference archive size mismatch')
    checksum = hashlib.sha256()
    with archive_path.open('rb') as source:
        for block in iter(lambda: source.read(65536), b''):
            checksum.update(block)
    if checksum.hexdigest() != pins['sha256']:
        raise ValueError('Reference archive checksum mismatch')
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) > pins['shardCount'] + 10:
            raise ValueError('Too many archive entries')
        names = set()
        files = {}
        for entry in entries:
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            if (not entry.filename or path.is_absolute() or '..' in path.parts or '\\' in entry.filename
                    or entry.filename in names or entry.flag_bits & 1
                    or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
                raise ValueError('Unsafe reference archive member')
            names.add(entry.filename)
            if entry.is_dir():
                continue
            if not 0 < entry.file_size <= MAX_FILE:
                raise ValueError('Reference file exceeds asset limit')
            files[entry.filename] = entry
        manifests = [name for name in files if PurePosixPath(name).name == 'manifest.learned.json']
        if len(manifests) != 1:
            raise ValueError('Exactly one reference manifest is required')
        manifest_name = manifests[0]
        entry = files[manifest_name]
        if entry.file_size != pins['manifestBytes']:
            raise ValueError('Reference manifest size mismatch')
        manifest_bytes = archive.read(entry)
        if hashlib.sha256(manifest_bytes).hexdigest() != pins['manifestSha256']:
            raise ValueError('Reference manifest checksum mismatch')
        manifest = json.loads(manifest_bytes)
        shards = manifest['shards']
        if len(shards) != pins['shardCount']:
            raise ValueError('Reference shard count mismatch')
        parent = PurePosixPath(manifest_name).parent
        expected = {manifest_name: (pins['manifestBytes'], pins['manifestSha256'])}
        for index, shard in enumerate(shards, 1):
            if (shard['file'] != f'features-{index:05d}.bin' or type(shard['bytes']) is not int
                    or not 0 < shard['bytes'] <= MAX_FILE or not re.fullmatch('[0-9a-f]{64}', shard['sha256'])):
                raise ValueError('Invalid reference shard contract')
            expected[str(parent/shard['file'])] = (shard['bytes'], shard['sha256'])
        # The pinned public ZIP includes nine release notices. The local packager
        # receives only numeric data; its distribution notices come from source.
        extras = set(files) - set(expected)
        if (not set(expected) <= set(files) or not extras <= ARCHIVE_NOTICES
                or any(files[name].file_size > 1024 * 1024 for name in extras)
                or sum(value[0] for value in expected.values()) != pins['referenceBytes']):
            raise ValueError('Unexpected reference files or total bytes')
        if any(files[name].file_size != size for name, (size, _) in expected.items()):
            raise ValueError('Reference file size mismatch')
        destination.mkdir(mode=0o700)
        for name, (size, expected_digest) in expected.items():
            digest = hashlib.sha256()
            total = 0
            with archive.open(files[name]) as source, (destination/PurePosixPath(name).name).open('xb') as target:
                while block := source.read(65536):
                    total += len(block)
                    if total > size:
                        raise ValueError('Expanded reference file exceeds pinned size')
                    digest.update(block)
                    target.write(block)
            if total != size or digest.hexdigest() != expected_digest:
                raise ValueError('Reference shard checksum mismatch')


def main(directory):
    pins = read_pins()
    directory.mkdir(mode=0o700)  # An explicit fresh build location, never a cache.
    archive_path = directory/'reference.zip'
    digest = hashlib.sha256()
    total = 0
    opener = urllib.request.build_opener(PublicReleaseRedirect())
    with opener.open(pins['url'], timeout=60) as source, archive_path.open('xb') as target:
        while block := source.read(65536):
            total += len(block)
            if total > pins['sizeBytes']:
                raise ValueError('Reference download exceeds pinned size')
            digest.update(block)
            target.write(block)
    if total != pins['sizeBytes'] or digest.hexdigest() != pins['sha256']:
        raise ValueError('Public reference download does not match reviewed source pins')
    extract_reference(archive_path, directory/'reference', pins)
    print('Verified pinned public reference archive and every extracted shard.')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Use fetch-static-reference.py /absolute/fresh/build-directory')
    try:
        main(Path(sys.argv[1]).resolve())
    except (ValueError, KeyError, OSError, zipfile.BadZipFile):
        raise SystemExit('Pinned reference preparation failed; incomplete build files were retained for inspection.') from None
