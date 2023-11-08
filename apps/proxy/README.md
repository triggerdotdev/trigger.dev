# Trigger.dev proxy

This is an optional module that can be used to proxy and queue requests to the Trigger.dev API.

## Why?

The Trigger.dev API is designed to be fast and reliable. However, if you have a lot of traffic, you may want to use this proxy to queue requests to the API. It intercepts some requests to the API and adds them to an AWS SQS queue.

## Setup

### 1. Create an AWS SQS queue

In AWS you should create a new AWS SQS queue with appropriate security settings. You will need the queue URL for the next step.

### 2. Add Cloudflare secrets

You use `wrangler` (the Cloudflare CLI tool) to set secrets.

```bash
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put AWS_SQS_QUEUE_URL
```

## Development

1. `pnpm install`
2. `pnpm run dev --filter proxy`
