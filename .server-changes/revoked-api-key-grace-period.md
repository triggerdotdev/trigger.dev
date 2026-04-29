---
area: webapp
type: feature
---

Regenerating a RuntimeEnvironment API key no longer invalidates the previous key immediately. The old key is recorded in a new `RevokedApiKey` table with a 24 hour grace window, and `findEnvironmentByApiKey` falls back to it when the submitted key doesn't match any live environment. The grace window can be ended early (or extended) by updating `expiresAt` on the row.
