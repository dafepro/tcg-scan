import base64
import copy
import json
import re
import unittest
import urllib.error
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

import source_queue_fallback as fallback

SHA = 'a' * 40
RUN_ID = 7
RUN_PATH = f'{fallback.BASE}/actions/runs/{RUN_ID}'


class Clock:
    def __init__(self):
        self.seconds = 0

    def now(self):
        return self.seconds

    def sleep(self, seconds):
        self.seconds += seconds


def step(name='Run npm ci', status='queued', conclusion=None, started_at=None):
    return dict(name=name, status=status, conclusion=conclusion, started_at=started_at)


def job(name='checks', identity=10, **overrides):
    result = dict(id=identity, run_id=RUN_ID, name=name, status='queued', conclusion=None,
                  labels=sorted(fallback.MAC), runner_id=0, runner_name='', steps=[], started_at=None)
    result.update(overrides)
    return result


class FakeGitHub:
    def __init__(self, clock):
        self.clock = clock
        self.repo = dict(full_name=fallback.REPO, private=False, visibility='public')
        self.run = dict(id=RUN_ID, repository=dict(full_name=fallback.REPO),
            head_repository=dict(full_name=fallback.REPO), actor=dict(id=fallback.OWNER),
            head_sha=SHA, head_branch='main', event='workflow_dispatch', run_attempt=1,
            path='.github/workflows/ci.yml', workflow_id=99, status='queued', conclusion=None,
            created_at=datetime.now(timezone.utc).isoformat())
        self.jobs = [job()]
        self.writes = []
        self.reads = []
        self.phase = 'watch'
        self.run_hook = None
        self.jobs_hook = None
        self.before_write = None
        self.cancel_terminal = True
        self.error_path = None
        self.main_sha = SHA

    def call(self, path, method='GET'):
        if self.error_path and self.error_path in path:
            raise fallback.Blocked('Simulated API error')
        if method == 'POST':
            self.writes.append((path, self.clock.now()))
            if self.before_write:
                self.before_write(path)
            if path == RUN_PATH + '/cancel':
                self.phase = 'cancel'
                if self.cancel_terminal:
                    self.run.update(status='completed', conclusion='cancelled')
                    for item in self.jobs:
                        if item['status'] != 'completed':
                            item.update(status='completed', conclusion='cancelled')
                return None
            if path == RUN_PATH + '/rerun':
                self.phase = 'rerun'
                return None
            raise AssertionError(path)
        self.reads.append(path)
        if path == fallback.BASE:
            return copy.deepcopy(self.repo)
        if path == fallback.BASE + '/git/ref/heads/main':
            return dict(ref='refs/heads/main', object=dict(type='commit', sha=self.main_sha))
        if '/actions/workflows/' in path:
            return dict(id=99, path=self.run['path'], state='active')
        if '/contents/' in path:
            workflow_path = path.split('/contents/')[1].split('?')[0]
            content = (Path(__file__).resolve().parents[1]/workflow_path).read_bytes()
            return dict(type='file', path=workflow_path, size=len(content), encoding='base64',
                content=base64.b64encode(content).decode())
        if path == RUN_PATH:
            if self.run_hook:
                self.run_hook(self)
            return copy.deepcopy(self.run)
        if '/attempts/1/jobs?' in path:
            if self.jobs_hook:
                self.jobs_hook(self)
            page = int(path.split('page=')[-1])
            return dict(total_count=len(self.jobs), jobs=copy.deepcopy(self.jobs[(page-1)*100:page*100]))
        raise AssertionError(path)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.api = FakeGitHub(self.clock)

    def watch(self):
        return fallback.watch(self.api, RUN_ID, SHA, self.clock.now, self.clock.sleep)

    def blocked(self, expected=None):
        with self.assertRaises(fallback.Blocked):
            self.watch()
        if expected is not None:
            self.assertEqual([path for path, _ in self.api.writes], expected)

    def test_one_rerun_after_120_seconds_and_terminal_cancellation(self):
        self.assertIn('One Ubuntu rerun', self.watch())
        self.assertEqual(self.api.writes, [(RUN_PATH + '/cancel', 120), (RUN_PATH + '/rerun', 120)])

    def test_static_initial_verification_queue(self):
        self.api.run['path'] = '.github/workflows/static-release.yml'
        self.api.jobs = [job('verify / checks')]
        self.assertIn('One Ubuntu rerun', self.watch())

    def test_completed_ci_then_unstarted_publisher_without_side_effects(self):
        self.api.run['path'] = '.github/workflows/static-release.yml'
        self.api.jobs = [job('verify / checks', status='completed', conclusion='success', runner_id=2,
            runner_name='Mac', steps=[step(status='completed', conclusion='success', started_at='earlier'),
                step('Run actions/upload-artifact@sha', 'completed', 'skipped', 'earlier')]),
            job(fallback.PUBLISH, identity=11)]
        self.assertIn('One Ubuntu rerun', self.watch())

    def test_completed_ci_upload_prevents_retry(self):
        self.api.run['path'] = '.github/workflows/static-release.yml'
        self.api.jobs = [job('verify / checks', status='completed', conclusion='success', runner_id=2,
            runner_name='Mac', steps=[step('Run actions/upload-artifact@sha', 'completed', 'success', 'earlier')]),
            job(fallback.PUBLISH, identity=11)]
        self.blocked([])

    def test_publisher_ever_started_prevents_retry(self):
        self.api.run['path'] = '.github/workflows/static-release.yml'
        self.api.jobs = [job(fallback.PUBLISH, runner_id=2, runner_name='Mac', status='in_progress')]
        self.blocked([])

    def test_externally_cancelled_run_is_not_rerun(self):
        def external(api):
            if api.clock.now() >= 60:
                api.run.update(status='completed', conclusion='cancelled')
                api.jobs[0].update(status='completed', conclusion='cancelled')
        self.api.run_hook = external
        self.assertIn('no retry', self.watch())
        self.assertEqual(self.api.writes, [])

    def test_initial_success_or_failure_is_not_retried(self):
        for conclusion in ('success', 'failure', 'cancelled', 'timed_out'):
            with self.subTest(conclusion=conclusion):
                self.setUp()
                self.api.run.update(status='completed', conclusion=conclusion)
                self.assertIn('no retry', self.watch())
                self.assertEqual(self.api.writes, [])

    def test_unsupported_owner_branch_event_repo_workflow_or_attempt(self):
        changes = [('actor', dict(id=1)), ('head_branch', 'feature'), ('event', 'pull_request'),
            ('head_repository', dict(full_name='attacker/fork')), ('repository', dict(full_name='another/repo')),
            ('head_sha', 'b'*40), ('path', '.github/workflows/unrelated.yml'), ('run_attempt', 2)]
        for field, value in changes:
            with self.subTest(field=field):
                self.setUp()
                self.api.run[field] = value
                self.blocked([])

    def test_private_or_unknown_visibility_is_ineligible(self):
        for changes in (dict(private=True, visibility='private'), dict(private=None), dict(visibility=None)):
            with self.subTest(changes=changes):
                self.setUp()
                self.api.repo.update(changes)
                self.blocked([])

    def test_visibility_change_before_cancel(self):
        def changed(api):
            if api.clock.now() >= 120:
                api.repo.update(private=True, visibility='private')
        self.api.run_hook = changed
        self.blocked([])

    def test_visibility_change_after_cancel(self):
        self.api.before_write = lambda _path: self.api.repo.update(private=True, visibility='private')
        self.blocked([RUN_PATH + '/cancel'])

    def test_pending_billing_environment_or_concurrency_is_not_mac_queue(self):
        for status in ('pending', 'waiting', 'billing_pending', 'unknown'):
            with self.subTest(status=status):
                self.setUp()
                self.api.run['status'] = status
                self.blocked([])

    def test_ubuntu_already_selected(self):
        self.api.jobs[0]['labels'] = ['ubuntu-24.04']
        self.assertIn('already selected', self.watch())
        self.assertEqual(self.api.writes, [])

    def test_missing_or_other_labels_never_cancel(self):
        for labels in ([], ['self-hosted'], ['ubuntu-latest']):
            with self.subTest(labels=labels):
                self.setUp()
                self.api.jobs[0]['labels'] = labels
                with patch.object(fallback, 'WATCH_SECONDS', 150):
                    self.blocked([])

    def test_job_started_at_is_not_a_queue_duration(self):
        self.api.jobs[0]['started_at'] = '1970-01-01T00:00:00Z'
        self.watch()
        self.assertEqual(self.api.writes[0][1], 120)

    def test_assignment_or_started_step_prevents_cancel(self):
        for changes in (dict(runner_id=2), dict(runner_name='Mac'),
                dict(steps=[step(status='in_progress', started_at='now')])):
            with self.subTest(changes=changes):
                self.setUp()
                self.api.jobs[0].update(changes)
                self.assertIn('no retry', self.watch())
                self.assertEqual(self.api.writes, [])
                self.assertEqual(self.clock.now(), 0)

    def test_malformed_or_missing_step_evidence(self):
        for steps in ([{}], [dict(name='x')], [step(status='unknown')],
                      [step(status='completed')], [None]):
            with self.subTest(steps=steps):
                self.setUp()
                self.api.jobs[0]['steps'] = steps
                self.blocked([])

    def test_queue_age_begins_when_job_is_observed_not_at_run_creation(self):
        self.api.jobs = []
        def appears(api):
            if api.clock.now() >= 60 and not api.jobs:
                api.jobs = [job()]
        self.api.jobs_hook = appears
        self.watch()
        self.assertEqual(self.api.writes[0][1], 180)

    def test_started_job_never_becomes_eligible_again(self):
        def requeue(api):
            api.jobs[0]['runner_id'] = 2 if api.clock.now() == 60 else 0
        self.api.jobs_hook = requeue
        with patch.object(fallback, 'WATCH_SECONDS', 300):
            self.assertIn('no retry', self.watch())
            self.assertEqual(self.api.writes, [])

    def test_in_progress_even_without_runner_evidence_never_becomes_eligible_again(self):
        def requeue(api):
            api.jobs[0]['status'] = 'in_progress' if api.clock.now() == 60 else 'queued'
        self.api.jobs_hook = requeue
        with patch.object(fallback, 'WATCH_SECONDS', 300):
            self.assertIn('no retry', self.watch())
            self.assertEqual(self.api.writes, [])

    def test_no_jobs_has_a_120_second_discovery_bound(self):
        self.api.jobs = []
        self.blocked([])
        self.assertEqual(self.clock.now(), 120)

    def test_stale_main_initially_or_before_cancel_prevents_retry(self):
        for initial in (True, False):
            with self.subTest(initial=initial):
                self.setUp()
                if initial:
                    self.api.main_sha = 'b' * 40
                else:
                    def changed(api):
                        if api.clock.now() >= 120:
                            api.main_sha = 'b' * 40
                    self.api.run_hook = changed
                self.blocked([])

    def test_main_advances_after_cancel_prevents_rerun(self):
        self.api.before_write = lambda _path: setattr(self.api, 'main_sha', 'b' * 40)
        self.blocked([RUN_PATH + '/cancel'])

    def test_old_or_unknown_run_creation_time_is_not_recovered(self):
        for created in (None, 'bad', '2020-01-01T00:00:00Z',
                        (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()):
            with self.subTest(created=created):
                self.setUp()
                self.api.run['created_at'] = created
                self.blocked([])

    def test_original_workflow_must_contain_exact_reviewed_rerun_contract(self):
        original = self.api.call
        def old(path, method='GET'):
            result = original(path, method)
            if '/contents/' in path:
                content = b'name: old Mac-only workflow\n'
                result.update(size=len(content), content=base64.b64encode(content).decode())
            return result
        self.api.call = old
        self.blocked([])

    def test_start_race_on_pre_cancel_read(self):
        reads = []
        def race(api):
            if api.clock.now() >= 120:
                reads.append(1)
                if len(reads) >= 2:
                    api.jobs[0].update(status='in_progress', runner_id=2, runner_name='Mac')
        self.api.run_hook = race
        self.blocked([])

    def test_start_race_after_cancel_does_not_rerun(self):
        def race(api):
            if api.phase == 'cancel':
                api.jobs[0].update(runner_id=2, runner_name='Mac',
                    steps=[step(status='completed', conclusion='cancelled', started_at='race')])
        self.api.run_hook = race
        self.blocked([RUN_PATH + '/cancel'])

    def test_transient_start_during_cancel_cannot_be_erased_by_later_metadata(self):
        observed = []
        def race(api):
            if api.phase == 'cancel':
                observed.append(1)
                if len(observed) == 1:
                    api.run.update(status='in_progress', conclusion=None)
                    api.jobs[0].update(status='in_progress', conclusion=None, runner_id=2,
                        runner_name='Mac', steps=[step(status='in_progress', started_at='race')])
                else:
                    api.run.update(status='completed', conclusion='cancelled')
                    api.jobs[0].update(status='completed', conclusion='cancelled', runner_id=0,
                        runner_name='', steps=[])
        self.api.run_hook = race
        self.blocked([RUN_PATH + '/cancel'])

    def test_cancel_202_without_terminal_proof_does_not_rerun(self):
        self.api.cancel_terminal = False
        self.blocked([RUN_PATH + '/cancel'])
        self.assertGreaterEqual(self.clock.now(), 540)

    def test_terminal_run_with_nonterminal_job_does_not_rerun(self):
        def not_done(api):
            if api.phase == 'cancel':
                api.jobs[0]['status'] = 'queued'
        self.api.jobs_hook = not_done
        self.blocked([RUN_PATH + '/cancel'])

    def test_missing_observed_job_does_not_rerun(self):
        def missing(api):
            if api.phase == 'cancel':
                api.jobs = []
        self.api.jobs_hook = missing
        self.blocked([RUN_PATH + '/cancel'])

    def test_success_at_cancellation_race_is_not_retried(self):
        def success(api):
            if api.phase == 'cancel':
                api.run['conclusion'] = 'success'
        self.api.run_hook = success
        self.assertIn('no retry', self.watch())
        self.assertEqual([path for path, _ in self.api.writes], [RUN_PATH + '/cancel'])

    def test_manual_rerun_or_stale_attempt_stops_automatic_rerun(self):
        def manual(api):
            if api.phase == 'cancel':
                api.run['run_attempt'] = 2
        self.api.run_hook = manual
        self.blocked([RUN_PATH + '/cancel'])

    def test_api_read_failure_never_causes_mutation(self):
        self.api.error_path = '/attempts/1/jobs'
        self.blocked([])

    def test_cancel_error_is_not_retried(self):
        calls = []
        def error(path):
            calls.append(path)
            raise fallback.Blocked('Simulated 409 or uncertain acceptance')
        self.api.before_write = error
        self.blocked([RUN_PATH + '/cancel'])
        self.assertEqual(calls, [RUN_PATH + '/cancel'])

    def test_rerun_error_is_not_retried(self):
        def error(path):
            if path.endswith('/rerun'):
                raise fallback.Blocked('Simulated uncertain rerun acceptance')
        self.api.before_write = error
        self.blocked([RUN_PATH + '/cancel', RUN_PATH + '/rerun'])


class PaginationTests(unittest.TestCase):
    def test_complete_multiple_pages(self):
        api = FakeGitHub(Clock())
        api.jobs = [job(identity=index+1) for index in range(101)]
        self.assertEqual(len(fallback.list_jobs(api, RUN_ID)), 101)
        self.assertEqual(len(api.reads), 2)

    def test_second_page_error_missing_duplicate_or_changing_total_fails_closed(self):
        for mode in ('error', 'missing', 'duplicate', 'total'):
            with self.subTest(mode=mode):
                class Pages:
                    def call(self, path):
                        if path.endswith('page=1'):
                            return dict(total_count=101, jobs=[job(identity=i+1) for i in range(100)])
                        if mode == 'error':
                            raise fallback.Blocked('Pagination API failure')
                        return dict(total_count=102 if mode == 'total' else 101,
                            jobs=[] if mode == 'missing' else [job(identity=1 if mode == 'duplicate' else 101)])
                with self.assertRaises(fallback.Blocked):
                    fallback.list_jobs(Pages(), RUN_ID)

    def test_oversized_or_malformed_inventory_fails_closed(self):
        for value in (dict(total_count=1001, jobs=[]), dict(total_count=1, jobs=[None]),
                      dict(total_count=1, jobs=[job(identity=True)])):
            with self.subTest(value=value):
                class Pages:
                    def call(self, _path):
                        return value
                with self.assertRaises(fallback.Blocked):
                    fallback.list_jobs(Pages(), RUN_ID)


class ConfigurationTests(unittest.TestCase):
    def test_workflow_owner_public_guards_and_duplicate_watcher_concurrency(self):
        root = Path(__file__).resolve().parents[1]
        watcher = (root/'.github/workflows/source-queue-fallback.yml').read_text()
        self.assertIn('types: [requested]', watcher)
        self.assertIn('group: tcg-source-queue-fallback-${{ github.event.workflow_run.id }}', watcher)
        self.assertIn('cancel-in-progress: false', watcher)
        self.assertIn('github.event.workflow_run.run_attempt == 1', watcher)
        self.assertIn("toJSON(github.event.repository.private) == 'false'", watcher)
        self.assertIn('permissions: {}', watcher)
        self.assertIn('actions: write', watcher)
        self.assertNotIn('secrets.', watcher)
        self.assertNotIn('contents: write', watcher)
        for filename in ('ci.yml', 'static-release.yml'):
            content = (root/'.github/workflows'/filename).read_text()
            self.assertIn("github.repository == 'dafepro/tcg-scan'", content)
            self.assertIn("github.actor_id == '313492551'", content)
            self.assertIn("github.ref == 'refs/heads/main'", content)
            self.assertIn("github.triggering_actor == 'dafepro'", content)
            self.assertIn("github.run_attempt == 2 && github.triggering_actor == 'github-actions[bot]' && toJSON(github.event.repository.private) == 'false'", content)
            self.assertIn("runs-on: ${{ !(github.run_attempt == 2 && github.triggering_actor == 'github-actions[bot]') &&", content)
        release = (root/'.github/workflows/static-release.yml').read_text()
        self.assertIn('name: Publish retained static site', release)
        self.assertIn('group: static-release', release)

    def test_actual_runner_expressions_preserve_manual_choices_and_block_unknown_initiators(self):
        root = Path(__file__).resolve().parents[1]
        cases = [(1, 'dafepro', 'mac', False, True, sorted(fallback.MAC)),
                 (2, 'dafepro', 'mac', False, True, sorted(fallback.MAC)),
                 (2, 'github-actions[bot]', 'mac', False, True, 'ubuntu-24.04'),
                 (2, 'unknown[bot]', 'mac', False, False, None),
                 (3, 'github-actions[bot]', 'mac', False, False, None),
                 (2, 'github-actions[bot]', 'mac', True, False, None),
                 (2, 'github-actions[bot]', 'mac', None, False, None),
                 (2, 'github-actions[bot]', 'mac', '', False, None),
                 (2, 'github-actions[bot]', 'mac', 'false', False, None),
                 (1, 'dafepro', 'github', False, True, 'ubuntu-24.04'),
                 (3, 'dafepro', 'github', False, True, 'ubuntu-24.04')]
        for filename in ('ci.yml', 'static-release.yml'):
            source = (root/'.github/workflows'/filename).read_text()
            runner = re.search(r'runs-on: \$\{\{ (.*?) \}\}', source).group(1)
            guard = re.search(r'    if: (.*?)(?=\n    (?:runs-on|uses):)', source, re.S).group(1)
            guard = ' '.join(guard.removeprefix('>-').split())
            for attempt, actor, choice, private, admitted, expected in cases:
                with self.subTest(file=filename, attempt=attempt, actor=actor, choice=choice, private=private):
                    values = {'github.repository': fallback.REPO, 'github.actor_id': str(fallback.OWNER),
                        'github.ref': 'refs/heads/main', 'github.run_attempt': attempt,
                        'github.triggering_actor': actor, 'github.event.repository.private': private,
                        'github.event_name': 'workflow_dispatch', 'inputs.build_runner': choice,
                        'vars.BUILD_RUNNER': 'mac', 'vars.DEPLOY_REQUESTS_ENABLED': 'true'}
                    def evaluate(expression):
                        for key, value in values.items():
                            expression = expression.replace(key, repr(value))
                        expression = expression.replace('&&', ' and ').replace('||', ' or ')
                        expression = re.sub(r'!(?!=)', 'not ', expression)
                        # Evaluate only checked-in expressions, with no builtins.
                        return eval(expression, {'__builtins__': {}, 'fromJSON': json.loads, 'toJSON': json.dumps})
                    self.assertEqual(bool(evaluate(guard)), admitted)
                    if admitted:
                        result = evaluate(runner)
                        self.assertEqual(sorted(result) if isinstance(result, list) else result, expected)

    def test_transport_never_retries_uncertain_write_or_exposes_other_repository(self):
        api = fallback.GitHub('ephemeral-test-token')
        class Broken:
            calls = 0
            def open(self, *_args, **_kwargs):
                self.calls += 1
                raise urllib.error.URLError('timeout')
        api.opener = Broken()
        with self.assertRaises(fallback.Blocked):
            api.call(RUN_PATH + '/cancel', 'POST')
        self.assertEqual(api.opener.calls, 1)
        with self.assertRaises(fallback.Blocked):
            api.call('/repos/dafepro/deploy/actions/runs/1/cancel', 'POST')
        self.assertEqual(api.opener.calls, 1)


if __name__ == '__main__':
    unittest.main()
