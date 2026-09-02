---
"trigger.dev": patch
---

Deploy image builds no longer spend time (and disk churn) removing `node_modules` while assembling the code layer; the layer is now copied with the dependency tree excluded. Large projects should see noticeably faster builds.
