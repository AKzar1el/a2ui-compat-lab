# Post-action message-history replay: real React acceptance test

The published A2UI v0.9 React / web_core renderer maintains two-way-bound input
edits locally. A client `action` can carry the user's changed value, but it is
not an agent `updateDataModel` event. A host that persists only the agent A2UI
messages plus client actions must define a policy if that post-action state
should survive rebuilding the surface.

The offline Chromium regression `renderer-react/scripts/message-history-regression.mjs`
executes a synthetic public `TextField` + `Button` fixture on the **installed**
published SDK pair (currently pinned at 0.14.0). It types `beta` into an
initial `alpha` binding, confirms the real emitted Button action carries
`beta`, closes the page, and rebuilds in a fresh React page from **only**
the saved agent messages. The value is again `alpha`. An explicit illustrative
host/agent `updateDataModel` then restores `beta`; a subsequent authoritative
agent update overrides it with `gamma`. The test asserts actual DOM input
values and SDK model snapshots at each boundary, without any LLM, off-origin
network access or private user capture.

This demonstrates a **host replay-policy gap**, not an SDK vulnerability or a
normative requirement that renderers synthesize data-model events. It does not
test third-party host persistence, durability of an agent echo, or user uptake.
It deliberately emits only booleans to the normal CI checkpoint report.

Run via `cd renderer-react && npm test` after the pinned offline dependencies
and Chromium are installed. External rationale:
[a2ui-project/a2ui#2932](https://github.com/a2ui-project/a2ui/issues/2932)
and the [v0.9 protocol's two-way binding contract](https://github.com/a2ui-project/a2ui/blob/main/specification/v0_9/docs/a2ui_protocol.md).

## Opt-in host policy: optimistic replay from saved client actions

A public [integrator reply in upstream #2932](https://github.com/a2ui-project/a2ui/issues/2932#issuecomment-6975901104)
clarifies a concrete requirement: a web chat host intentionally persists only the
agent and user message stream, not out-of-band form snapshots. That integrator
describes action-derived optimistic state and later agent-authored state taking
precedence. This is third-party **problem and desired-behavior evidence**, not
proof that this Lab is deployed in that host or that A2UI specifies the policy.

The same offline published React/Chromium test now contrasts two explicit
host policies after a real captured `submit-choice` client action:

- **Agent echo:** apply a subsequent agent-authored `updateDataModel` to
  restore the field; a later agent update overrides it.
- **Action-derived optimistic replay:** rebuild from agent messages, then
  resolve the saved action against the **trusted original** Button definition
  and its single absolute `/choice` path binding. The host synthesizes one
  data-model update to restore the submitted field without an agent echo;
  a later agent-authored update again overrides it. Refuse mismatched
  surface/component/event, unexpected action context and unsupported binding.

The latter is a deliberately narrow, fail-closed **test policy**, not a generic
or secure production binding inverter. It does not infer relative paths,
literal/function expressions, multiple fields, action rejection semantics,
or edits not submitted in an action. Real host adoption and a cross-host
semantic contract remain unverified. The regression returns only boolean
checkpoints, never recorded user field values.

## Deleted-surface action replay safety

The synthetic action-derived host policy additionally refuses an old Button
submission if the persisted agent history contains `deleteSurface` for that
surface, even when an earlier trusted Button schema still matches. The offline
Chromium test also checks that the published React renderer unmounts that
surface and drops its data model. This conservative rule avoids treating a
captured action as permission to restore a deleted or later-recreated surface.
It does **not** resolve message-stream temporal correlation, distinguish
surface lifetimes after ID reuse, or establish behavior in an external host.

## Chronological transcript ordering (synthetic host policy)

A saved conversation may contain an agent-created form, a client Button action,
**then** an agent-authored update that rejects or supersedes the submitted value.
Applying all agent history first and replaying the optimistic action last would
incorrectly replace that later authoritative agent update. The offline real
Chromium fixture now reconstructs one interleaved sequence in original order:
agent messages, the actual saved Button action resolved against the preceding
trusted component definition, then an agent `updateDataModel`. It asserts the
fresh React DOM and model finish with the agent's `gamma`, not the earlier
submitted `beta`.

## Bounded two-turn replay from real captured actions

The same offline published React/Chromium fixture now captures **two actual**
Button submissions, not synthetic action objects: `beta`, an intervening
agent-authored `/choice` update to `gamma`, and a distinct second submission
of `delta`. Chronological reconstruction from the saved messages and actions
shows `delta` before the second agent response and `epsilon` afterward, in
the mounted React DOM and model. Action-before-definition, two consecutive
actions without an intervening agent `/choice` update, a repeated identical
choice, and a third action are rejected conservatively rather than silently
replayed.

This intentionally bounded host-policy test does **not** infer agent acceptance,
correlate response IDs, support unchanged-value re-submission, reuse a deleted
surface, or establish arbitrary multi-turn replay interoperability. Treating
an agent `/choice` update as a turn boundary is a local fixture restriction,
not a protocol contract; independent host acceptance and adoption remain
unverified.
