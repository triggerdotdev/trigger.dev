---
"@trigger.dev/plugins": patch
---

Consolidate authentication and authorization into the `RoleBaseAccessController` contract. The interface now covers the full per-request flow — authenticate the caller, return a pre-built ability, optionally fold in an action + resource check — for both Bearer (API key + PAT + Public JWT) and session-cookie callers. Replaces several ad-hoc auth helpers consumers were stitching together themselves. Resources passed to `ability.can` may be a single `RbacResource` or an array (any element matches, for records addressable by multiple identifiers). Mutation methods return discriminated `Result` types so user-facing error strings flow through without try/catch.
