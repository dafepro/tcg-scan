#!/usr/bin/env python3
"""Bind the retained archive to the exact source, root build and reference audit."""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

directory = Path(sys.argv[1])
sha = os.environ['GITHUB_SHA']
if not re.fullmatch('[0-9a-f]{40}', sha):
    raise ValueError('A complete source identity is required')
report_path = directory/'assets/deployment-report.json'
report = json.loads(report_path.read_text())
if report['build']['basePath'] != '/' or report['hosting']['requiredNotFoundHandling'] != 'none':
    raise ValueError('The reviewed root routing contract is required')
digest = hashlib.sha256()
with (directory/'worker.tgz').open('rb') as source:
    for block in iter(lambda: source.read(65536), b''):
        digest.update(block)
checksum = digest.hexdigest()
manifest = dict(schema=2, sha=sha, controllerSha=sha, profile='production', checksum=checksum,
                reportSha256=hashlib.sha256(report_path.read_bytes()).hexdigest(),
                referenceManifestSha256=report['release']['manifestSha256'], basePath='/')
with (directory/'release-manifest.json').open('x') as target:
    json.dump(manifest, target, indent=2)
    target.write('\n')
