# A2UI guarded integration

This repository integrates safe, explicitly handed-off worker PRs using its own scheduled GitHub Actions workflow. The separate shared RevenueShot_GuardedPRMerge service is not modified or extended.

- Runs at minutes 17, 37 and 57 UTC and can be started manually in dry-run mode.
- Performs exactly one SHA-pinned merge commit at most per run.
- Only AKzar1el-authored, non-draft, clean PRs from revshot/* to the current main are considered.
- A PR must contain a single exact body line: MERGER_HANDOFF: AKzar1el/a2ui-compat-lab@<full HEAD SHA>. Comments do not count as a handoff.
- Source/testing/documentation changes are narrowly allowed. Changes to GitHub Actions, packages, dependency lockfiles, project/worker policies and merge/security controls require separate owner review and manual integration.
- Requires no unresolved human review threads, no requested reviewers, no hold labels, clean branch ancestry, successful exact-head sdk-parity, react-browser and dependency-audit jobs, and green CI on current main.
- Re-reads the PR and main SHA immediately before merging, then calls the GitHub merge API with the exact source head SHA. It does not rebase, bypass review protections or overwrite files.
- GitHub Actions GITHUB_TOKEN merges do not normally emit subsequent push-triggered workflows, so the merger explicitly dispatches a new main CI after a successful merge.
- Any missing status, ambiguous check, GitHub API failure or changed head is a **stop**, never permission to bypass safeguards.

This does not guarantee unattended merging for changes involving security, workflows or dependency upgrades. The owner must explicitly review those and merge them separately. After a legitimate merge the worker should fetch the new main and start a fresh branch rather than replaying old commits.

Run the workflow manually with dry_run=true to see what would be eligible without mutating branches. The scheduled runs perform real merges only for fully qualified PRs.

## CI-completion wake (separately reviewed protected change)

The existing UTC cron and manual dry-run remain available. A completed `A2UI Compatibility CI` **pull_request** run with `conclusion=success` additionally wakes the **same** guarded integration job. Main-branch push, manual CI, failed, cancelled or still-running CI cannot start that job through `workflow_run`. This addresses the observed sparse cron-delivery records in [issue #144](https://github.com/AKzar1el/a2ui-compat-lab/issues/144), but is not evidence that GitHub has fixed cron or that the new event will always arrive.

**A CI event is not merge authorization.** The trusted default-branch `scripts/guarded-merge.mjs` does not trust the event's `pull_requests` array, artifacts, source branch or changed workflow. It independently lists live PRs and rechecks the exact current main SHA, a fresh exact-main CI run, three required exact-head jobs, status checks, reviewer holds, path allowlist, SHA handoff, ancestry and last-second PR/main SHA before merging at most one PR. The existing single-flight concurrency and guarded manual semantics remain unchanged. An empty `pull_requests` array in CI run REST metadata does not suppress the wake or relax the live checks.

**Privilege boundary:** GitHub's `workflow_run` event can receive a write-scoped `GITHUB_TOKEN` even when the originating CI ran untrusted PR code. Therefore the merger must continue checking out only trusted default-branch code, never the PR head, and must never execute a PR artifact, cache, script or event-supplied command. The event is used solely to decide whether the trusted guard should evaluate live repository state. No third-party service, key or paid infrastructure is added.

**Review and acceptance:** Changes to this protected workflow are **not** eligible for the scheduled source-only merger and require explicit owner review/manual integration. PR-head CI can check existing tests but cannot prove the new `workflow_run` behavior before merge because GitHub resolves the listener from the default branch. After approved integration, verify a successful same-repository PR CI completion creates a separate guard run; verify failed/cancelled CI and main CI do not run `integrate`, and verify an ineligible or stale PR is refused. Monitor actual event delivery, PR waiting time, and extra GitHub Actions minutes. Keep the cron fallback; do not claim guaranteed delivery or savings until observed.

Sources: [GitHub `workflow_run` semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), [secure Actions usage](https://docs.github.com/en/actions/reference/security/secure-use).
