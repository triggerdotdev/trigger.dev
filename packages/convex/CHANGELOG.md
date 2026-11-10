# @trigger.dev/convex

## 4.8.4

### Patch Changes

- Add a bundled agent skill for integrating Trigger.dev with Convex, including transactional triggering, Realtime progress, recovery, and scoped-token safety. Install it manually from the package; it is not part of the CLI skills installer. ([`9422dc65d`](https://github.com/triggerdotdev/trigger.dev/commit/9422dc65d26e745a8d3670a7977d04b938553d9d))

## 4.8.3

### Patch Changes

- Add `trigger.refresh(ctx, id)` to request an earlier status check for a Convex-tracked run, so applications using Trigger Realtime can publish results without waiting for the next scheduled poll. Requests are coalesced and rate-limited, use the existing completion callback, and retain polling as a recovery fallback. ([`ee5e5da40`](https://github.com/triggerdotdev/trigger.dev/commit/ee5e5da4073f930b8ee20b9fe0da798de4612494))

## 4.8.2

### Patch Changes

- Add an experimental Convex component for triggering tasks transactionally and reading their status and results through reactive queries, without configuring webhooks. ([`3c1cf656c`](https://github.com/triggerdotdev/trigger.dev/commit/3c1cf656cd5006e61ca144629998764cabf2ae55))
