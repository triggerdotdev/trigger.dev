---
"@trigger.dev/core": patch
---

Fix `parseNaturalLanguageDurationInMs` silently dropping repeated units. The validation pattern accepts a unit appearing more than once (e.g. `"1h2h"`), but each unit was read with a single match, so only the first occurrence counted. It now sums every token.
