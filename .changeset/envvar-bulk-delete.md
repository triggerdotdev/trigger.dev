---
"@trigger.dev/core": patch
---

Add a bulk delete endpoint for environment variables, `POST /api/v1/projects/:projectRef/envvars/:slug/bulk-delete`, which removes up to 1000 variables from one environment in a single call and can be limited to values last written by a given source or to branch values that shadow a value on the parent environment.
