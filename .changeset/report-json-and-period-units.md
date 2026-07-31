---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Reports can now be fetched as structured data, not just text: ask for the `json` format and you get the numbers and what they mean, typed. Report periods are also stricter — the shortest window is one minute (`30m`, `1h`, `7d`), because reports summarise data by the minute and anything shorter can't be answered honestly.
