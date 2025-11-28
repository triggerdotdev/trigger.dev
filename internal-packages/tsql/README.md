# TSQL (TriggerSQL)

TriggerSQL is a DSL that is safely converted into ClickHouse SQL queries with protection against SQL injection and it's tenant-safe (users can only query their own data).

## ANTLR Grammar

The ANTLR grammer is heavily inspired by [PostHog's HogQL](https://github.com/PostHog/posthog/tree/master/posthog/hogql).

These are found in [./grammar] and are the `.g4` files.

## Generating the source code

```sh
pnpm run grammar:build
```
