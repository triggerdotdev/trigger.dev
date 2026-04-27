# TSQL (TriggerSQL)

TriggerSQL is a DSL that is safely converted into ClickHouse SQL queries with protection against SQL injection and it's tenant-safe (users can only query their own data).

## Attribution

This package is derived from [PostHog's HogQL](https://github.com/PostHog/posthog/tree/master/posthog/hogql) (MIT License). See [NOTICE.md](./NOTICE.md) for the full copyright notice.

## ANTLR Grammar

The ANTLR grammar is heavily inspired by PostHog's HogQL.

These are found in [./src/grammar](./src/grammar) and are the `.g4` files.

## Generating the source code

```sh
pnpm run grammar:build
```
