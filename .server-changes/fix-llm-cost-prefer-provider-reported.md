---
area: webapp
type: fix
---

AI generation cost now uses the exact provider-reported cost from OpenRouter/Vercel AI Gateway when present, instead of catalog pricing, so cache-discounted and fallback-routed requests match the amount the provider actually billed.
