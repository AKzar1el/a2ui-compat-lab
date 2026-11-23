# Opt-in trusted custom v0.9 catalog replay

For developer-authored local Catalog instances, `src/replay-catalogs.mjs` provides
`createTrustedV09Processor` and `replayV09WithTrustedCatalogs`. Both use
the installed published `@a2ui/web_core@0.15.0` library and default to the
built-in basic catalog. They do **not** load a catalog, schema, or executable
code from untrusted JSONL captures.

```js
import {replayV09WithTrustedCatalogs} from './src/replay-catalogs.mjs';
// 'customCatalog' must be created by your trusted application code.
const result = replayV09WithTrustedCatalogs(myMessages, {
  trustedCatalogs: [customCatalog],
});
console.log(result.snapshots);
```

Caller-supplied catalogs must be actual published v0.9 `Catalog` instances.
Registration rejects empty IDs, protocol mismatches, duplicate custom IDs,
and collisions with the built-in basic ID, irrespective of order or object
identity. An unknown catalog ID referenced in a capture fails closed.
The `__BASIC_CATALOG__` replay alias remains accepted for the built-in ID.

This is a **headless state and SDK-action building block**, not an arbitrary
component renderer. The helper `createTrustedV09Processor` supplies a real
MessageProcessor to callers who need binder-driven actions; callers own
`processor.model.dispose()` and `processor.dispose()` in their cleanup.
The minimal `replayV09WithTrustedCatalogs` wrapper records component and
data snapshots for 1-1000 in-memory messages and releases both processor
and model. It does not simulate clicks. Neither component visualization nor
HotGrid rendering in Chromium is asserted. The React harness remains pinned
to the strict-compatible 0.14 pair and needs separate version-specific
custom-component registration.

See issue #191 for the real-world public custom-catalog pattern, upstream
version boundary, and synthetic published-SDK test evidence. This does not
establish adoption, customer demand, sales, or an upstream SDK security bug.
