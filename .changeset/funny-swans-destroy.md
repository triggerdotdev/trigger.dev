---
"@trigger.dev/sdk": patch
---

Make msw a normal dependency (for now) to fix Module Not Found error in Next.js.

It turns out that webpack will "hoist" dynamically imported modules and attempt to resolve them at build time, even though it's an optional peer dep:

https://x.com/maverickdotdev/status/1782465214308319404
