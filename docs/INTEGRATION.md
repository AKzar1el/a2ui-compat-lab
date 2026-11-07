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
