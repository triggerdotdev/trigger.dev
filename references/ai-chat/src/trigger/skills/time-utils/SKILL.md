---
name: time-utils
description: Compute and format dates/times in arbitrary timezones using a small set of bundled bash scripts. Use when the user asks about "what time is it", "current time in <city>", date math, or timezone conversions.
---

# Time utilities

This skill bundles small bash scripts that shell out to `date` for timezone-aware answers without the model having to reason about offsets.

## When to use

- The user asks for the current time in a specific timezone (e.g. "what time is it in Tokyo?")
- The user wants a date formatted in a specific way
- The user needs a relative time (e.g. "what's the date 3 days from now?")

## Scripts

### `scripts/now.sh [TZ]`

Prints the current time in the given IANA timezone (default `UTC`). Example:

```
bash scripts/now.sh America/Los_Angeles
```

### `scripts/add.sh DAYS [TZ]`

Prints a date `DAYS` days from now in the given timezone. `DAYS` can be negative. Example:

```
bash scripts/add.sh 3 Europe/London
```

## Tips

- IANA timezone names only (`America/New_York`, not `EST`).
- See `references/timezones.txt` for a short cheat-sheet of common zones.
