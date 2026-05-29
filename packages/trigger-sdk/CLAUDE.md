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
2. Test with `references/hello-world` reference project
3. Docs updates (`docs/`) are usually done in a separate PR

Do NOT update `rules/` or `.claude/skills/trigger-dev-tasks/` unless explicitly asked. These are maintained in separate dedicated passes.
