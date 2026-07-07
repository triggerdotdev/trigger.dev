---
"@trigger.dev/sdk": patch
---

Fix chat turns that throw (for example from an `onTurnStart` hook) leaking their message listener, which lost or duplicated messages sent during later turns.
