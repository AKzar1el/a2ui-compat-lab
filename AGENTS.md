# A2UI Compatibility Lab — working contract

PROJECT_KEY: a2ui_compat_lab
SOURCE_ROOT: C:\Users\Tomi\Desktop\lol\a2ui-compat-lab
GITHUB_REPO: AKzar1el/a2ui-compat-lab

## Workspace isolation
- Use ONLY the existing shared GENERAL Codexify God v5 tunnel, never a new tunnel or the Codex CLI.
- In a new scheduled ChatGPT conversation, select this exact project with `set_project_root(path=SOURCE_ROOT, createWorktree=false)` when unbound, then read `get_agent_brief` and `get_environment` before code.
- If another project is bound or the correct source checkout cannot be selected, never issue project-scoped commands against that project. Use the independent GitHub connector only for `AKzar1el/a2ui-compat-lab` as a remote-only feature-branch/PR fallback; if that is unavailable, report the blocker and retry on the next wake. Never pause the hourly A2UI automation solely for binding trouble.
- Use one ordinary source checkout. Do not create linked worktrees. Do not reset, stash, clean, overwrite or delete other workers' or user files.
- Treat working-tree changes, untracked files, local journals and open PRs as first-class unfinished work to resume before new research.

## Definition of an acceptable hourly Revenue Shot
- Inspect remote/main and existing PR statuses once per wake; preserve owned unfinished work.
- Choose one bounded task in `docs/ROADMAP.md` with an observable acceptance test or user outcome.
- Prefer tests that find differences across published SDK packages over copying existing upstream conformance cases.
- Maintain offline/reproducible tests. Any external npm probes are opt-in, bounded, cached and should not run every wake.
- Never suppress test failures, invent metrics, claim a renderer was tested without rendering it, or call expected known bugs security vulnerabilities.
- Avoid paid services or sensitive real-world endpoints; do not access secrets for ordinary fixtures.
- When safe and permitted, commit an owned scoped change, open a GitHub PR, verify checks and hand off to the existing merger without changing the fleet or overwriting main.
- Keep a concise file-backed run receipt in `worker/RUN_LOG.md`: branch, SHA, files changed, commands/tests, PR link and remaining blockers.
- Honor the owner's existing 25–35-minute productive / closeout cadence and reserve at least eight minutes for closeout when the schedule/runtime allows. Do not let a long npm install consume the entire wake.
- If no safe productive task can be done, report the blocker and exit instead of making unneeded changes.
- For parallel/race safety, never operate when another active writer owns this checkout.
- No changes to any other automation, Codexify configuration, scheduler, or shared service without explicit owner instruction.

## Quality gates
```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run scan:check
node src/cli.mjs scan --strict --out out/differential.json
python scripts/python_parity.py --ts out/differential.json
```
The Python parity command assumes `a2ui-core==0.5.0` has been installed in a dedicated environment. `npm run probe:releases` is network-dependent and deliberately separate from routine CI.

Consult `docs/EVIDENCE.md`, `docs/ROADMAP.md`, `worker/WORKER_PROMPT.md` before new features.
