---
area: supervisor
type: feature
---

Add an opt-in, dev-only telnet log stream: set `SUPERVISOR_TELNET_LOGS_PORT` (e.g. 6769) to tail this process's logs as plain text over a local TCP socket (`nc localhost 6769`). Bound to localhost; off unless the port is set.
