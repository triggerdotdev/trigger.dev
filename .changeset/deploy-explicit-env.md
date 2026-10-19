---
"trigger.dev": patch
"@trigger.dev/core": patch
---

`trigger deploy` and `trigger promote` now say which environment they're targeting, and accept `--prod` as a shorthand for `--env prod`. When `TRIGGER_ACCESS_TOKEN` holds an environment API key and you don't pass `--env`, they now use that key's environment instead of assuming prod. Passing an `--env` that doesn't match the key is now an error, where before the deploy went to the key's environment.

Preview deploys now detect the branch on CI providers that check out a detached HEAD, such as GitLab, Bitbucket, CircleCI, Buildkite, Travis CI, Jenkins and Azure Pipelines, instead of creating a branch called `HEAD`. Test links printed after a preview deploy now open the preview branch you deployed instead of staging.

The MCP `deploy` tool no longer defaults to prod, so your AI assistant has to choose the environment.
