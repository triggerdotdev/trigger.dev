---
area: webapp
type: improvement
---

Session external ids can no longer contain a `/channels` path segment (for example `chat-1/channels/support`) or end in `:channels`, since both forms name a session's channels. Creating a session with one now returns a 422 validation error.
