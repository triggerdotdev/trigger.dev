---
"@trigger.dev/sdk": patch
---

Cancel abandoned HTTP response bodies before retrying in `retry.fetch()` and only clone/read the response body once when a `bodyFilter` rule matches.
