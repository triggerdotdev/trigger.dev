---
area: webapp
type: improvement
---

The db seed now mints (and prints) a Personal Access Token for the seeded
`local@trigger.dev` user. This lets the CLI authenticate against a local
instance via `TRIGGER_ACCESS_TOKEN` without the browser magic-link flow, which
matters for headless/agent onboarding. Idempotent: re-seeding decrypts and
reprints the existing `local-dev-cli` token instead of creating new ones.
