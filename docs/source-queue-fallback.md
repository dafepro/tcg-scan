# Public source queue recovery

This change is limited to `dafepro/tcg-scan` source CI and retained static-release
production. It adds no deployment credentials, runner registration or persistent
token. It does not provide automatic cloud recovery for the private
`dafepro/deploy` controller. That repository's release-request processing,
validation and production deployment remain a separate operational decision;
exhausted private-repository minutes are not permission to incur charges.

## Permission and eligibility

The new `source-queue-fallback.yml` workflow has no default token permissions.
Only its `watch` job receives `contents: read` and `actions: write` on the
existing job-lifetime `GITHUB_TOKEN`. Approval of that Actions permission is
required before installing the change. Technically it can manage Actions runs
in this source repository; the reviewed code restricts its writes to cancelling
and rerunning one eligible original run. It has no cross-repository access,
contents-write permission, release token or deployment token.

The watcher uses standard `ubuntu-24.04`, whose Actions compute is free for a
public repository. It checks the expected public repository at admission and
again before each write. Private/unknown visibility fails closed. It never buys
minutes, changes a spending limit, chooses a larger runner, creates credentials
or changes another application's route. Source job guards still require the
owner ID `313492551`, `dafepro/tcg-scan`, `main`, and manual workflow dispatch.
The retained-release enable flag is unchanged.

## Bounded queue policy

1. A separate Ubuntu watcher starts only for an initial `workflow_run: requested`
   event from `CI` or `Build a retained tcg-scan static release`. It verifies the
   live workflow ID/path, original actor, source SHA, branch and event. Initial
   runs older than two hours are refused. Original CI/release workflow bytes
   must exactly match the trusted checked-out recovery contract, so an older
   Mac-only workflow cannot accidentally be rerun on Mac again. Live `main` must
   still equal the original source SHA at entry and before both writes.
2. It polls every 15 seconds and measures at least 120 continuous seconds from
   first observation of an actual queued job with the exact four Mac labels.
   It gives GitHub at most 120 seconds to expose a concrete job and stops as
   soon as verification genuinely starts. Workflow creation time, pending
   concurrency, billing/approval states and
   `timeout-minutes` are not queue-age evidence. An assigned runner, any observed
   `in_progress` state, or an executed step makes that job ineligible forever.
3. It rechecks the same job immediately before requesting whole-run cancellation.
   No other job may still be running. There is no per-job cancellation API used.
4. After its own accepted cancellation, it waits up to seven minutes for the
   original run to be `completed/cancelled`, every attempt job to be completed,
   and the timed-out job to be cancelled without assignment or execution. All
   pages and previously observed job IDs must still be accounted for. A race,
   incomplete metadata, API error or unconfirmed cancellation stops recovery.
5. Only then does it request one whole-run rerun of the same run ID. GitHub keeps
   the original actor, source SHA and ref, and increments `run_attempt`. Only
   attempt 2 initiated by `github-actions[bot]` receives the automatic standard
   Ubuntu override, including when the first attempt explicitly selected Mac.
   Owner (`dafepro`) manual reruns retain their original runner selection.
   Unknown rerun initiators and later bot attempts are rejected before runner
   allocation. No original-owner or successful-producer provenance check is
   relaxed. GitHub documents the initiating-actor distinction but its exact
   built-in-token rerun login still requires live qualification; no such runtime
   qualification is claimed here.

Cancellation or rerun requests with uncertain responses are never retried.
External cancellations, ordinary test/build failures, stale/manual reruns,
unknown workflow/job shapes and cancellation timeouts never initiate recovery.
The watcher is serialized by the original run ID, with `cancel-in-progress:
false`; a second watcher sees the newer attempt or terminal state and stops.
The producer's existing concurrency group continues to serialize releases.

## Side effects and limits

The publisher must never have acquired a runner or executed. Any executed
upload step also blocks recovery, even if it belongs to an earlier successful
CI job. The existing CI normally uploads its browser report, so this policy
usually recovers only the initial verification queue. A completed CI followed
by a queued publisher is eligible only when the full metadata proves uploads
were skipped and there were no publication side effects. The watcher never
selects an old partially published release or retries an in-progress deployment.

The canonical `Publish retained static site` name, pointer schema, immutable
release identity and central successful-run/attempt checks remain unchanged.
The successful Ubuntu attempt publishes its own exact attempt number. A
cancelled producer cannot satisfy the central release validator.

The 120-second policy is enforced by the running watcher, not a GitHub scheduling
SLA. If GitHub delays or cannot start that Ubuntu control job, or its API fails,
this change cannot promise a wall-clock cutoff from dispatch. The original Mac
job can remain queued; no speculative parallel build or deployment is started.
The observation cap is five minutes and job timeout 15 minutes, including the
separate seven-minute cancellation wait. A terminal GitHub
status is not treated as proof that an already-started disconnected machine has
stopped; that is why assignment/execution makes recovery ineligible.

GitHub offers no conditional atomic cancel/rerun operation. Live public-status
and run-attempt checks minimize races, but an owner changing repository
visibility or manually rerunning between the final check and API request is not
atomically preventable. Event-level visibility is historical on a rerun. Do not
change visibility or manually retry a run while recovery is active; a strict
account-wide no-spend guarantee also requires an enforced zero-spend policy.
This change does not configure account billing or claim such a guarantee.

## Verification

Run `npm run test:runner-fallback`. Its standard-library Python tests use a fake
clock and GitHub API; they make no network calls and cancel/dispatch nothing.
They cover the 120-second minimum, exact identities/workflow bytes, public
eligibility, billing/pending states, pagination/errors, incomplete step/job
evidence, execution races, external cancellation, cancellation timeout, manual
reruns, publication/upload history, and duplicate-watcher concurrency wiring.
The command is included in `npm run check`.

These tests do not prove live GitHub event delivery, billing configuration,
runner availability or platform cancellation timing. An owner-approved runtime
qualification with an intentionally unavailable test runner is still needed
before describing queue recovery as operationally verified. Never use a live
deployment to test cancellation races.

## Platform references

- [Self-hosted runner routing and the 24-hour queue limit](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [Workflow cancellation and conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)
- [Cancel and rerun REST APIs](https://docs.github.com/en/rest/actions/workflow-runs)
- [Rerun actor, SHA and ref preservation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)
- [Job-lifetime, repository-scoped GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
