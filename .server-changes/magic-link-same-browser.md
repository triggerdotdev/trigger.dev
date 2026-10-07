---
area: webapp
type: improvement
---

Magic links now only sign you in from the browser that requested them, so a link opened elsewhere (including by an email security scanner) no longer logs anyone in. Self-hosted instances can turn this off with `MAGIC_LINK_SAME_BROWSER_REQUIRED=false`.
