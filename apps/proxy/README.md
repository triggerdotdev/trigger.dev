# Trigger.dev proxy

This is an optional module that can be used to proxy and queue requests to the Trigger.dev API.

## Why?

The Trigger.dev API is designed to be fast and reliable. However, if you have a lot of traffic, you may want to use this proxy to queue requests to the API. It intercepts some requests to the API and adds them to an AWS SQS queue.

## How to use

## Development

1. `pnpm install`
2. `pnpm run dev --filter proxy`
