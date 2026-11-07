# Worker backlog — usefulness first

## P0: Harden and ship the independent proof

- Confirm all offline tests, Python parity, and clean published-release matrix on Windows and GitHub CI.
- Normalize fixture identifiers, record exact SDK versions, and export machine-readable results with stable fields.
- Add a bounded CLI `--version` and clean-install diagnostic command.
- Investigate failing CI or package installation, prioritize actual user-facing evidence over cosmetic cleanup.
- Verify baseline drift handling does not label upstream bug fixes as product failures.
- Add a fail-closed report mode when npm registry is unreachable (never mistake a network error for a dependency incompatibility).

## P1: Actual A2UI UI/action replay (core differentiation)

- First replay target: v0.9.1 protocol and React; pin `@a2ui/react`, `@a2ui/web_core` and React runtime to known-working combinations.
- Create deterministic fixtures for `createSurface`, `updateComponents`, `updateDataModel`, actions and surface deletion. Never require an LLM or deployed model.
- Capture resulting actions and state; replay at multiple chunk boundaries and assert stable state snapshots.
- Render at least one real surface in a browser harness and detect component-level failures. Compare against upstream issue #3993; avoid merely copying its known repro.
- Add accessibility and keyboard-action assertions, then try Lit and Angular after React proves worthwhile.
- Distinguish official conformance test coverage from integrated application behavior; add evidence of a missed case before claiming novelty.

## P2: Go-to-market validation

- Review README with actual third-party A2UI integrators, request practical problems and evidence.
- Build an example GitHub Action with artifacts and a readable regression diff, first for free open-source users.
- Add badges/docs only after they accurately reflect passing tests.
- Do not introduce paid hosting, inference APIs, SaaS billing or unrelated products without owner approval.

## Worker rule

Every wake: first inspect existing work, unfinished branches and GitHub PRs; complete useful incomplete work before selecting a new feature. Contribute production-quality tested code rather than accumulating exploratory plans. Work in one ordinary checkout, not linked worktrees, and preserve all other workers' files.
