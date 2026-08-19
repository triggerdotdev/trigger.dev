---
"trigger.dev": patch
---

`trigger.dev deploy --external-id` tags a deployment with an id of your own — a commit SHA, a CI run id, a release tag — so runs triggered by that release of your app go to that deployment. Deploying an id that is already deployed builds nothing and reports the existing version instead of creating a duplicate; use `--force` to rebuild it.
