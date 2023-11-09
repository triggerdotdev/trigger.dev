# Trigger.dev proxy

This is an optional module that can be used to proxy and queue requests to the Trigger.dev API.

## Why?

The Trigger.dev API is designed to be fast and reliable. However, if you have a lot of traffic, you may want to use this proxy to queue requests to the API. It intercepts some requests to the API and adds them to an AWS SQS queue, then the webapp can be setup to process the queue.

## Current features

- Intercepts `sendEvent` requests and adds them to an AWS SQS queue. The webapp then reads from the queue and creates the events.

## Setup

### 1. Create an AWS SQS queue

In AWS you should create a new AWS SQS queue with appropriate security settings. You will need the queue URL for the next step.

### Environment variables

#### Cloudflare secrets

Locally you should copy the `.dev.var.example` file to `.dev.var` and fill in the values.

When deploying you should use `wrangler` (the Cloudflare CLI tool) to set secrets.

```bash
wrangler secret put REWRITE_HOSTNAME
wrangler secret put AWS_SQS_ACCESS_KEY_ID
wrangler secret put AWS_SQS_SECRET_ACCESS_KEY
wrangler secret put AWS_SQS_QUEUE_URL
wrangler secret put AWS_SQS_REGION
```

#### Webapp

These env vars also need setting in the webapp, however you normally would do that.

```bash
AWS_SQS_REGION
AWS_SQS_ACCESS_KEY_ID
AWS_SQS_SECRET_ACCESS_KEY
AWS_SQS_QUEUE_URL
AWS_SQS_BATCH_SIZE
```

## Development

Set the environment variables as described above.

1. `pnpm install`
2. `pnpm run dev --filter proxy`
