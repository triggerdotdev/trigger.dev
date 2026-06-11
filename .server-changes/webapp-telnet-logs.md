---
area: webapp
type: feature
---

Add an opt-in, dev-only telnet log stream: set `WEBAPP_TELNET_LOGS_PORT` (e.g. 6767) to tail this process's logs as plain text over a local TCP socket (`nc localhost 6767`). Bound to localhost; off unless the port is set.
