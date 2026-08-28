---
"trigger.dev": patch
---

Native build server deploys now show build logs the same way Depot builds do: a single spinner line updated with the latest message, with the last 20 lines printed if the build fails. Pass `--build-logs full` to stream every line; CI, `--plain` and piped output always use full.
