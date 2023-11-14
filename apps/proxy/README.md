# Trigger.dev proxy

This is an optional module that can be used to proxy and queue requests to the Trigger.dev API.

## Why?

The Trigger.dev API is designed to be fast and reliable. However, if you have a lot of traffic, you may want to use this proxy to queue requests to the API. It intercepts some requests to the API and adds them to an AWS SQS queue, then the webapp can be setup to process the queue.

## Current features

- Intercepts `sendEvent` requests and adds them to an AWS SQS queue. The webapp then reads from the queue and creates the events.

## Setup

### Create an AWS SQS queue

In AWS you should create a new AWS SQS queue with appropriate security settings. You will need the queue URL for the next step.

### Environment variables

#### Cloudflare secrets

Locally you should copy the `.dev.var.example` file to `.dev.var` and fill in the values.

When deploying you should use `wrangler` (the Cloudflare CLI tool) to set secrets. Make sure you set the correct --env ("staging" or "prod")

```bash
wrangler secret put REWRITE_HOSTNAME --env staging
wrangler secret put AWS_SQS_ACCESS_KEY_ID --env staging
wrangler secret put AWS_SQS_SECRET_ACCESS_KEY --env staging
wrangler secret put AWS_SQS_QUEUE_URL --env staging
wrangler secret put AWS_SQS_REGION --env staging
```

You need to set your API CNAME entry to be proxied by Cloudflare. You can do this in the Cloudflare dashboard.

#### Webapp

These env vars also need setting in the webapp.

```bash
AWS_SQS_REGION
AWS_SQS_ACCESS_KEY_ID
AWS_SQS_SECRET_ACCESS_KEY
AWS_SQS_QUEUE_URL
AWS_SQS_BATCH_SIZE
```

## Deployment

Staging:

```bash
npx wrangler@latest deploy --route "<your-api-subdomain>/*" --env staging
```

Prod:

```bash
npx wrangler@latest deploy --route "<your-api-subdomain>/*" --env prod
```

## Development

Set the environment variables as described above.

1. `pnpm install`
2. `pnpm run dev --filter proxy`
