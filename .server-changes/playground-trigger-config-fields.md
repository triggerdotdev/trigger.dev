---
area: webapp
type: fix
---

Playground action now forwards `maxDuration`, `version` (as `lockToVersion`), and `region` from the sidebar form into the Session's `triggerConfig`. Previously the form fields rendered as working controls but were silently dropped (`void`-suppressed) because `SessionTriggerConfig` didn't accept them — runs ignored the user's max duration, version pin, and region selection. With the schema extended in core, the playground now plumbs them through to `ensureRunForSession`.

Also fixes stale `clientData` in the playground transport: the JSON editor's value was captured at construction and never updated, so per-turn `metadata` merges used the original value across the whole conversation. Added a `useEffect` that calls `transport.setClientData(...)` whenever `clientDataJson` changes.
