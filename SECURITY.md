# Security policy — 7 November 2026

A2UI Compatibility Lab is a **local developer test harness**, not a production renderer for arbitrary untrusted A2UI catalogs.

## Mitigations applied

- React harness: DOMPurify 3.4.17 pinned via npm override, fixing GHSA-cg2g-xh64-v4q7.
- React development tooling: Vite 7.3.7, replacing vulnerable 7.1.12.
- Root reference validation: Ajv 8.20.0, replacing vulnerable 8.17.1.
- A2UI SDK versions remain intentionally pinned at 0.14.0 (React) and 0.15.0 (schema parity).

## Unresolved high-severity issue

The published A2UI versions require **Zod ^3.25.76**. Advisory **GHSA-mrhx-c7xc-m3w5** describes a memory-exhaustion issue in Zod 3 validation of oversized constrained collections. Its patched line is Zod 4, which is not semver-compatible with these SDK releases.

**This vulnerability is NOT fixed or suppressed.** The repository CI runs two real npm audits and discloses its transitive manifestations. A precisely scoped exception is allowed only for the pinned Zod 3.25.76 advisory until **2026-12-07 UTC**. New advisories, changed versions, unexpected vulnerabilities, registry outages, and expired exceptions fail the security job. Do not represent green CI as a clean npm audit.

Avoid deploying these pinned versions for a public application that accepts arbitrary untrusted schemas. Keep fixture and transport limits in force. Review upstream A2UI/Zod upgrades promptly; changing SDK versions requires rerunning cross-SDK differential fixtures and browser tests.

To validate: first npm ci at root and renderer-react, then run node scripts/security-audit.mjs --strict --out out/security.json. This requires npm registry access and does not alter npm policy.

Security alerts and proposed fixes may be raised on GitHub Issues. Do not ignore the known advisory permanently.
