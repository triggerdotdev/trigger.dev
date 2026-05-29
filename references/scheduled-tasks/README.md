# scheduled-tasks reference

E2E test bed for the schedule engine. Designed to verify the worker-payload flow
that carries `payload.lastTimestamp` forward across fires (no DB round-trip,
no cron-derivation drift).

## Setup

1. Create a project in the local webapp at http://localhost:3030 and copy the
   project ref from Project Settings.
2. Replace `proj_REPLACE_ME` in `trigger.config.ts` with that ref.
3. From this directory:

```bash
pnpm exec trigger login -a http://localhost:3030 --profile local
pnpm exec trigger dev --profile local
```

4. Open the project in the dashboard and visit each schedule. Click "Attach to
   environment" → dev. The first fire happens at the next cron slot.

## What to look for

- **`first-fire-detector`** — first run of a freshly-attached schedule should
  log `first-fire-detector PASS (first fire)` with `lastTimestamp: null`.
  Subsequent runs log `PASS (Nth fire)` with a Date.
- **`interval-validator`** — every non-first fire of an every-minute task
  should log `interval-validator PASS` with `actualIntervalMs: 60000`. A
  `FAIL` here means the worker payload isn't carrying the previous fire time
  correctly.
- **`upcoming-validator`** — every fire should log `upcoming-validator PASS`
  with 10 strictly-increasing slots, each 60s apart.
- **`every-minute`**, **`every-five-minutes`**, **`hourly-utc`** — sanity
  checks across cadences. Inspect `payload` in the dashboard to confirm
  `timestamp` and `lastTimestamp` look right.
- **`daily-*`** schedules — won't fire during a short dev session, but the
  attach action should enqueue a Redis job for the next slot in the listed
  timezone. Worth checking that next-fire time matches the expected wall-clock
  in that tz.
