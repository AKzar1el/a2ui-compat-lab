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
