---
area: supervisor
type: fix
---

Copy `scripts/retry-prisma-generate.mjs` into the supervisor image build before `pnpm run generate`. The database packages' `generate` scripts shell out to that file, so the supervisor `Containerfile` fails to build without it. Companion to the same fix in the webapp Dockerfile (#4156).
