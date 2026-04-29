---
area: webapp
type: fix
---

Public Access Tokens (PATs) minted before an API key rotation now keep working during the 24h grace window. `validatePublicJwtKey` falls back to any non-expired `RevokedApiKey` rows for the signing environment when the primary signature check against the env's current `apiKey` fails. The fallback query only runs on the failure path, so the hot success path is unchanged.
