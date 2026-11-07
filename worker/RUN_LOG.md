# A2UI Compatibility Lab — worker receipts

## 2026-11-07 — Owner-approved bootstrap
- Origin: confirmed signed-agent alternative failed commercial differentiation; this second pilot identified real A2UI TS/Python validator drift and npm package-release incompatibility.
- Repo created as a separate `a2ui-compat-lab` checkout. First commit and CI status must be recorded here after verification.
- Initial tests: see `docs/EVIDENCE.md`; do not represent unexecuted browser/replay tests as complete.
- Next work: address highest-priority P0 item and only then begin P1 replay with real renderer.

## 2026-11-07 — Bootstrap closeout (verified)
- Canonical checkout: C:\Users\Tomi\Desktop\lol\a2ui-compat-lab (ordinary source checkout, no worktree).
- Initial commit: 86b5217b45ad8725e62c84f72d27d509477ba207, pushed to https://github.com/AKzar1el/a2ui-compat-lab (main).
- GitHub Actions: first run #42322050783 passed: https://github.com/AKzar1el/a2ui-compat-lab/actions/runs/42322050783.
- Gates: clean npm ci; Node 10/10 passing; 25 actual SDK fixtures with 9 pinned TS/Python disagreements; real Python A2UI Core 0.5.0 parity passed; release probes: 0.14 pair resolves, 0.15 pair gives expected ERESOLVE; headless real v0.9 MessageProcessor JSONL trace passed.
- Ready backlog: #1 release matrix robustness, #2 real browser interaction/recovery replay, #3 version-aware parity reports.
- Hourly scheduled worker created for minute :10 Europe/Ljubljana. Scheduler confirmed enabled; workspace binding must be inspected on first wake because originating conversation is bound to mcp-trendpulse. If wrong, require the Codexify setup card's explicit Switch to another project control. Never operate on the wrong project.
- Commercial status: pilot only; no revenue/customer validation; no browser-rendered UI replay yet.
## 2026-11-07 — First scheduled wake: fail-closed workspace guard
- Actual first task run completed early with the WRONG Codexify workspace: mcp-trendpulse, not a2ui-compat-lab.
- Worker correctly performed no project operations and paused the new A2UI automation. Existing fleet and source files remained untouched.
- Unblock manually in the A2UI scheduled run's Codexify setup card: choose 'Switch to another project', select C:\Users\Tomi\Desktop\lol\a2ui-compat-lab, ordinary source checkout, createWorktree:false.
- After an explicit correct selection and read-only git/remote verification, re-enable the SAME scheduled task. Do not create a duplicate task or a second tunnel.
- New A2UI task remains PAUSED until that user selection; do not describe it as running hourly yet.

## 2026-11-07 — Text JSONL frame resource-limit hardening
- Verified A2UI source checkout and origin AKzar1el/a2ui-compat-lab; main baseline a851a86; branch `revshot/a2ui-text-jsonl-limits-20261107`. PRs #4–#10 were open with green checks at inventory. Only pre-existing untracked `renderer-react/` remained, preserved without staging or modification.
- Reproduced harness bug: 2,060-byte JSONL frame with trailing whitespace accepted under `maxLineBytes: 32`; original complete-line path checked byte length only AFTER trimming. New regression tests failed before the fix and passed afterward. No upstream SDK security claim.
- Source commit `512fdd98a2f9a544875735fe7ce6fb1122c0cb99`: incremental untrimmed UTF-8 byte counting across text chunks (including split UTF-16 surrogate pairs and CRLF), configurable maxMessages=10,000, two new regression tests, README/EVIDENCE notes.
- Local gates: `npm test` 12/12 PASS; `npm run scan:check` 25 fixture / 9 expected deviations MATCH; `node src/replay-report.mjs --out out/replay.json` PASS; `git diff --check` clean. No local Python parity or external release probe on this run; GitHub Actions owns Python verification.
- PR: https://github.com/AKzar1el/a2ui-compat-lab/pull/11, review and merge assigned to existing fleet merger. Exact final-head CI verification follows this append-only receipt commit; do not self-merge.
- Next priority after normal merger integration: real React browser-level fault injection/recovery and cross-renderer evidence; preserve untracked renderer files and avoid duplicate upstream conformance cases.
