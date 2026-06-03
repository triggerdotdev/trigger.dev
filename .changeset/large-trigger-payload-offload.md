---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Offload large trigger payloads to object storage before sending the trigger API request. The SDK uploads packets at or above the existing 128KB limit and sends an `application/store` pointer instead of embedding large JSON in the request body. `TriggerTaskRequestBody` now validates that `application/store` payloads are non-empty storage paths.

Payload uploads use the same resolved `ApiClient` as the trigger call (including `requestOptions.clientConfig`), not only the global `apiClientManager.client` — so custom `baseURL`, access token, and preview branch apply to both presign and trigger.
