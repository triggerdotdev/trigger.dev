---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Delete many environment variables in one call with `envvars.bulkDelete()`, backed by the new `POST /api/v1/projects/:projectRef/envvars/:slug/bulk-delete` endpoint. You can limit the delete to values last written by a given source, or to branch values that shadow a value on the parent environment, and the response lists the keys that were deleted and the keys that were skipped.

```ts
import { envvars } from "@trigger.dev/sdk";

const result = await envvars.bulkDelete("proj_yubjwjsfkxnylobaqvqz", "dev", {
  keys: ["SLACK_API_KEY", "STRIPE_SECRET_KEY"],
});
```
