---
"trigger.dev": patch
---

`NODE_EXTRA_CA_CERTS` set as an environment variable now reaches the task process at startup instead of being overwritten by the image's empty default.
