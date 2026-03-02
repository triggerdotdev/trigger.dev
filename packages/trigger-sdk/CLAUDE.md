# Trigger.dev SDK

`@trigger.dev/sdk` - the main customer-facing SDK for writing background tasks.

## Import Rules

Always import from `@trigger.dev/sdk`. Never use `@trigger.dev/sdk/v3` (deprecated path alias).

## Key Exports

- `task` - Define a background task
- `schedules.task` - Define a scheduled (cron) task
- `batch` - Batch trigger operations
- `runs` - Run management and polling
- `wait` - Wait for events, delays, or other tasks
- `retry` - Retry utilities
- `queue` - Queue configuration
- `metadata` - Run metadata access
- `logger` - Structured logging

## When Adding Features

1. Implement the feature in the SDK
2. Don't update the `rules/` directory at repo root
3. Don't update the `.claude/skills/trigger-dev-tasks/` skill files
4. Add/update docs in `docs/` (Mintlify MDX format). These will almost always be updated in a separate PR.
5. Test with `references/hello-world` reference project
