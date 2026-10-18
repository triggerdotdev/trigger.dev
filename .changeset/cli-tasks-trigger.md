---
"trigger.dev": patch
---

Add `trigger.dev tasks trigger <task id>` to trigger a task from your terminal. It uses the dev environment unless you pass `--env`, and `--wait` waits for the run and prints its output or error, exiting with code 1 if it failed. The `runs` commands now use the same dev branch as `trigger dev` when you pass `--env dev`.

```bash
npx trigger.dev@latest tasks trigger hello-world --payload '{"name":"Ada"}' --wait
```
