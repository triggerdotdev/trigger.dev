# Issue 2687 Reproduction

This reference project reproduces the issue where `Realtime` returns 401 when using `createTriggerPublicToken`.

## Setup

1. Make sure your Trigger.dev instance is running (webapp).
2. Copy `.env.example` to `.env` and fill in your details:

```bash
cp .env.example .env
```

3. Edit `.env` to set your `TRIGGER_SECRET_KEY` and `TRIGGER_API_URL`.

## Running the reproduction

Run the reproduction script:

```bash
pnpm run repro
```

## What it does

1. Generates a `triggerPublicToken` for `issue-2687-task`.
2. Triggers the task using this token.
3. Attempts to connect to the Realtime endpoint for the resulting run using the same token.
