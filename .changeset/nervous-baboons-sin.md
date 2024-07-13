---
"trigger.dev": minor
"@trigger.dev/core": minor
---

Added config option extraCACerts to ProjectConfig type. This copies the ca file along with additionalFiles and sets NODE_EXTRA_CA_CERTS environment variable in built image as well as running the task.
