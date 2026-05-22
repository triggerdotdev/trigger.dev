---
name: greeter
description: Say hello in different styles. Use when the user asks for a greeting or a friendly message.
---

# Greeter

A tiny skill used to validate that the CLI bundles `SKILL.md` plus a `scripts/` subfolder into the deploy image and that `skill.local()` can read both at runtime.

## When to use

- Anyone asks for "hello" — invoke `scripts/hello.sh [NAME]` and return its stdout.

## Scripts

### `scripts/hello.sh [NAME]`

Prints `Hello, {NAME}!` (default `world`). Used to confirm `scripts/` is copied alongside `SKILL.md`.
