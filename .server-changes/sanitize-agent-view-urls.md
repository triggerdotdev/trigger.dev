---
area: webapp
type: fix
---

Sanitize URLs from streamed agent and tool data before rendering them in the dashboard's Agent view, so an unsafe scheme such as `javascript:` can no longer produce a clickable link or image source.
