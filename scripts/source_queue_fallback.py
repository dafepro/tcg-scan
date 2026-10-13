#!/usr/bin/env python3
"""One fail-closed retry of an owner-dispatched, unstarted public Mac job.

This controller never builds, publishes, deploys, or reads deployment secrets.
The original run is rerun so owner, source SHA and producer provenance survive.
"""
import base64
import binascii
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = 'dafepro/tcg-scan'
BASE = '/repos/' + REPO
OWNER = 313492551
WORKFLOWS = {
    '.github/workflows/ci.yml': {'checks'},
    '.github/workflows/static-release.yml': {'verify / checks', 'Publish retained static site'},
}
MAC = {'self-hosted', 'macOS', 'ARM64', 'dcarrell-mac'}
PUBLISH = 'Publish retained static site'
QUEUE_SECONDS = 120
POLL_SECONDS = 15
CANCEL_SECONDS = 420
DISCOVERY_SECONDS = 120
WATCH_SECONDS = 5 * 60
MAX_RUN_AGE_SECONDS = 2 * 60 * 60


class Blocked(RuntimeError):
    """No automatic retry is safe or sufficiently evidenced."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise Blocked('Unexpected GitHub API redirect')


class GitHub:
    def __init__(self, token):
        if not token:
            raise Blocked('Missing ephemeral GitHub token')
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def call(self, path, method='GET'):
        # Every caller supplies an allowlisted repository path and numeric IDs.
        if not path.startswith(BASE + '/') and path != BASE:
            raise Blocked('API target is outside the source repository')
        if '..' in path or '%' in path or '#' in path:
            raise Blocked('Invalid API path')
        request = urllib.request.Request('https://api.github.com' + path,
            method=method, data=b'{}' if method == 'POST' else None,
            headers={'Authorization': 'Bearer ' + self.token,
                     'Accept': 'application/vnd.github+json',
                     'Content-Type': 'application/json', 'User-Agent': 'tcg-source-queue-fallback',
                     'X-GitHub-Api-Version': '2022-11-28'})
        try:
            with self.opener.open(request, timeout=20) as response:
                payload = response.read(2 * 1024 * 1024 + 1)
                expected = 202 if path.endswith('/cancel') else 201 if method == 'POST' else 200
                if response.status != expected or len(payload) > 2 * 1024 * 1024:
                    raise Blocked('Unexpected GitHub API response')
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            # Never retry a write with uncertain acceptance. Do not print secrets.
            raise Blocked('GitHub API request failed; no automatic retry') from error
        try:
            value = json.loads(payload) if payload else None
            if method == 'GET' and not isinstance(value, dict):
                raise Blocked('Invalid GitHub API object')
            return value
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise Blocked('Invalid GitHub API response') from error


def positive_int(value):
    return type(value) is int and 0 < value < 2**63


def require_public(api):
    repo = api.call(BASE)
    if repo.get('full_name') != REPO or repo.get('private') is not False or repo.get('visibility') != 'public':
        raise Blocked('Fallback is limited to the verified public source repository')


def require_current_main(api, sha):
    ref = api.call(BASE + '/git/ref/heads/main')
    if ref.get('ref') != 'refs/heads/main' or ref.get('object', {}).get('type') != 'commit' or ref.get('object', {}).get('sha') != sha:
        raise Blocked('Source main advanced; do not revive a superseded run')


def validate_run(run, run_id, sha, workflow_id=None):
    if (run.get('id') != run_id or run.get('repository', {}).get('full_name') != REPO or
        run.get('head_repository', {}).get('full_name') != REPO or
        run.get('head_sha') != sha or run.get('head_branch') != 'main' or
        run.get('actor', {}).get('id') != OWNER or run.get('event') != 'workflow_dispatch' or
        run.get('run_attempt') != 1 or run.get('path') not in WORKFLOWS or
        not positive_int(run.get('workflow_id')) or
        (workflow_id is not None and run.get('workflow_id') != workflow_id)):
        raise Blocked('Run identity, owner, branch, workflow or initial attempt changed')


def validate_workflow_revision(api, sha, path):
    # Rerunning preserves original workflow bytes. Do not recover an old run
    # whose original revision would simply queue Mac again.
    paths = {'.github/workflows/ci.yml', path}
    root = Path(__file__).resolve().parents[1]
    for workflow_path in sorted(paths):
        value = api.call(f'{BASE}/contents/{workflow_path}?ref={sha}')
        if (value.get('type') != 'file' or value.get('path') != workflow_path or
            value.get('encoding') != 'base64' or type(value.get('size')) is not int or
            not 0 < value['size'] <= 65536 or not isinstance(value.get('content'), str)):
            raise Blocked('Cannot verify original workflow bytes')
        try:
            content = base64.b64decode(''.join(value['content'].split()), validate=True)
        except (ValueError, binascii.Error) as error:
            raise Blocked('Invalid original workflow encoding') from error
        if len(content) != value['size'] or content != (root/workflow_path).read_bytes():
            raise Blocked('Original workflow differs from the reviewed recovery contract')


def list_jobs(api, run_id):
    jobs, expected = [], None
    for page in range(1, 11):
        value = api.call(f'{BASE}/actions/runs/{run_id}/attempts/1/jobs?per_page=100&page={page}')
        total, batch = value.get('total_count'), value.get('jobs')
        if (type(total) is not int or not 0 <= total <= 1000 or not isinstance(batch, list) or
            len(batch) > 100 or (expected is not None and total != expected)):
            raise Blocked('Incomplete or changing job pagination')
        expected = total
        jobs.extend(batch)
        if len(batch) < 100:
            if len(jobs) != total or any(not isinstance(job, dict) for job in jobs):
                raise Blocked('Incomplete job inventory')
            ids = [job.get('id') for job in jobs]
            if any(not positive_int(value) for value in ids) or len(set(ids)) != len(ids):
                raise Blocked('Invalid or repeated job identity')
            return jobs
    raise Blocked('Job inventory exceeds the pagination bound')


def executed(step):
    # GitHub may attach timestamps to skipped steps; skipped is not execution.
    return step.get('conclusion') != 'skipped' and (
        step.get('started_at') is not None or step.get('status') in ('in_progress', 'completed'))


def unstarted(job):
    # started_at is not a reliable queue timestamp. Runner assignment and step
    # evidence must also be absent; an assigned-but-disconnected runner is unsafe.
    return (job.get('status') != 'in_progress' and job.get('runner_id') == 0 and job.get('runner_name') in ('', None) and
            not any(executed(step) for step in job['steps']))


def safe_jobs(jobs, run_id, path):
    allowed = WORKFLOWS[path]
    names = []
    for job in jobs:
        if (job.get('run_id') != run_id or job.get('name') not in allowed or
            job.get('status') not in ('queued', 'in_progress', 'completed') or
            not isinstance(job.get('steps'), list) or
            any(not isinstance(step, dict) for step in job['steps']) or
            not isinstance(job.get('labels'), list) or
            any(not isinstance(label, str) for label in job['labels']) or
            type(job.get('runner_id')) is not int or job['runner_id'] < 0 or
            not (job.get('runner_name') is None or isinstance(job['runner_name'], str))):
            raise Blocked('Unsupported or incomplete job metadata')
        for step in job['steps']:
            if (not {'name', 'status', 'conclusion', 'started_at'} <= step.keys() or
                not isinstance(step['name'], str) or not step['name'] or
                step['status'] not in ('queued', 'in_progress', 'completed') or
                step['conclusion'] not in (None, 'success', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out') or
                (step['status'] == 'completed' and step['conclusion'] is None) or
                (step['started_at'] is not None and not isinstance(step['started_at'], str))):
                raise Blocked('Ambiguous step execution evidence')
        names.append(job['name'])
        if job['name'] == PUBLISH and not unstarted(job):
            raise Blocked('Publisher acquired a runner or began execution')
        if any('upload' in str(step.get('name', '')).lower() and executed(step) for step in job['steps']):
            raise Blocked('An upload already began; repeating side effects is not automatic')
        if job['status'] == 'completed' and job.get('conclusion') not in ('success', 'skipped', 'cancelled'):
            raise Blocked('A job failed; source or infrastructure failures require review')
    if len(set(names)) != len(names):
        raise Blocked('Unexpected duplicate job names')


def watch(api, run_id, sha, now=time.monotonic, sleep=time.sleep):
    if not positive_int(run_id) or not re.fullmatch('[0-9a-f]{40}', sha):
        raise Blocked('A complete source run identity is required')
    require_public(api)
    require_current_main(api, sha)
    run_path = f'{BASE}/actions/runs/{run_id}'
    run = api.call(run_path)
    validate_run(run, run_id, sha)
    try:
        created = datetime.fromisoformat(run['created_at'].replace('Z', '+00:00'))
        if created.tzinfo is None or not 0 <= (datetime.now(timezone.utc) - created).total_seconds() <= MAX_RUN_AGE_SECONDS:
            raise ValueError('Run age')
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise Blocked('Initial run is too old or has no reliable creation time') from error
    validate_workflow_revision(api, sha, run['path'])
    workflow = api.call(BASE + '/actions/workflows/' + run['path'].split('/')[-1])
    workflow_id, path = workflow.get('id'), run['path']
    if workflow.get('path') != path or workflow_id != run['workflow_id'] or workflow.get('state') != 'active':
        raise Blocked('The exact source workflow is not active')

    observed_ids, started_ids = set(), set()

    def snapshot():
        current = api.call(run_path)
        validate_run(current, run_id, sha, workflow_id)
        jobs = list_jobs(api, run_id)
        safe_jobs(jobs, run_id, path)
        ids = {job['id'] for job in jobs}
        if not observed_ids <= ids:
            raise Blocked('An observed attempt job disappeared')
        observed_ids.update(ids)
        started_ids.update(job['id'] for job in jobs if not unstarted(job))
        return current, jobs

    end, discovery_end, first_seen = now() + WATCH_SECONDS, now() + DISCOVERY_SECONDS, {}
    candidate = None
    while now() < end:
        run, jobs = snapshot()
        if run.get('status') == 'completed':
            return 'Original run completed; no retry'
        if jobs and all(set(job['labels']) == {'ubuntu-24.04'} for job in jobs):
            return 'Standard Ubuntu was already selected; no retry'
        # Billing, environment approval, concurrency-pending or unknown states
        # are not evidence of an unstarted self-hosted runner queue.
        if run.get('status') not in ('queued', 'in_progress', 'requested'):
            raise Blocked('Run is pending, waiting or otherwise ineligible')
        eligible = [job for job in jobs if job['status'] == 'queued' and
                    set(job['labels']) == MAC and unstarted(job) and job['id'] not in started_ids]
        if not jobs and now() >= discovery_end:
            raise Blocked('No concrete Mac job appeared within the discovery window')
        if jobs and not eligible:
            if any(job['id'] in started_ids or job['status'] == 'completed' for job in jobs):
                return 'Verification already started or finished; no retry'
            raise Blocked('No eligible unstarted Mac queue')
        ids = {job['id'] for job in eligible}
        first_seen = {key: value for key, value in first_seen.items() if key in ids}
        for job in eligible:
            first_seen.setdefault(job['id'], now())
            if now() - first_seen[job['id']] >= QUEUE_SECONDS:
                candidate = job['id']
                break
        if candidate is not None:
            break
        sleep(POLL_SECONDS)
    if candidate is None:
        raise Blocked('Observation window ended without a safe queue timeout')

    # Re-read immediately before the consequential request. A queued job can
    # acquire a runner between polls; never retry if that race is observed.
    run, jobs = snapshot()
    target = next((job for job in jobs if job['id'] == candidate), None)
    if (run.get('status') not in ('queued', 'in_progress') or target is None or
        target['status'] != 'queued' or set(target['labels']) != MAC or not unstarted(target) or
        candidate in started_ids or any(job['id'] != candidate and
            (job['status'] != 'completed' or job.get('conclusion') not in ('success', 'skipped')) for job in jobs)):
        raise Blocked('Timed-out job changed before cancellation')
    require_public(api)
    require_current_main(api, sha)
    api.call(run_path + '/cancel', 'POST')
    cancel_end = now() + CANCEL_SECONDS
    while now() < cancel_end:
        run, jobs = snapshot()
        if candidate in started_ids:
            raise Blocked('Timed-out job acquired execution evidence during cancellation')
        if run.get('status') == 'completed':
            if run.get('conclusion') != 'cancelled':
                return 'Original run completed without confirmed cancellation; no retry'
            target = next((job for job in jobs if job['id'] == candidate), None)
            if (target is None or not unstarted(target) or target.get('conclusion') != 'cancelled' or
                not jobs or any(job['status'] != 'completed' for job in jobs)):
                raise Blocked('Cancelled attempt has incomplete or raced execution evidence')
            break
        sleep(POLL_SECONDS)
    else:
        raise Blocked('Cancellation did not become terminal; no retry')

    # Check again after repository eligibility, including any owner/manual rerun.
    require_public(api)
    require_current_main(api, sha)
    run, jobs = snapshot()
    target = next((job for job in jobs if job['id'] == candidate), None)
    if (run.get('status') != 'completed' or run.get('conclusion') != 'cancelled' or
        candidate in started_ids or
        target is None or not unstarted(target) or target.get('conclusion') != 'cancelled' or
        any(job['status'] != 'completed' for job in jobs)):
        raise Blocked('Cancellation evidence changed before retry')
    api.call(run_path + '/rerun', 'POST')
    # No write retry: a timeout/409/ambiguous result requires manual inspection.
    return 'One Ubuntu rerun requested for the same owner, source SHA and run ID'


if __name__ == '__main__':
    try:
        message = watch(GitHub(os.environ.get('GH_TOKEN')), int(os.environ['SOURCE_RUN_ID']),
                        os.environ['SOURCE_RUN_SHA'])
    except (Blocked, KeyError, ValueError, TypeError) as error:
        raise SystemExit('Source fallback stopped: ' + str(error)) from None
    print(message)
