---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
"trigger.dev": patch
---

Chat in the browser now reconnects when the connection drops mid-turn, instead of leaving the reply stuck as if it were still generating. Reports can be fetched as structured data with the `json` format, and the shortest report period is now one minute (`1m`, `30m`, `1h`, `7d`). The `mint-token` command's help is clearer too: a token minted without `--cap` is read-only, and `--ttl` shows the correct maximum lifetime of 7 days.
