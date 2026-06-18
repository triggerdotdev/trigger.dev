---
"@trigger.dev/core": patch
---

The run span API response now includes `cachedCost` and `cacheCreationCost` on the `ai` object, alongside the existing `inputCost` / `outputCost` / `totalCost`. `inputCost` reflects only the non-cached input, so these fields let you reconstruct the full cost breakdown for prompt-cached calls.
