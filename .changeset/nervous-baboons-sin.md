---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Added config option extraCACerts to ProjectConfig type. This copies the ca file along with additionalFiles and sets NODE_EXTRA_CA_CERTS environment variable in built image as well as running the task.
