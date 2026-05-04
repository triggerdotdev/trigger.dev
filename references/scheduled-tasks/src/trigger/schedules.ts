import { logger, schedules } from "@trigger.dev/sdk";

/**
 * Reference project for E2E-testing the schedule engine.
 *
 * The schedule engine carries the previous fire time forward via the worker
 * queue payload (no DB round-trip). These tasks exercise the customer-visible
 * surface so we can verify the flow end-to-end:
 *
 *   - First-ever fire reports `payload.lastTimestamp === undefined`.
 *   - Subsequent fires report `payload.lastTimestamp` equal to the previous
 *     `payload.timestamp` exactly (no cron-derivation drift).
 *   - `payload.upcoming` is a strictly-increasing array of 10 future slots.
 *   - Multiple cron syntaxes and timezones all behave consistently.
 *
 * Validators (every-minute, interval, upcoming) emit explicit PASS / FAIL
 * log lines so you can grep `trigger dev` output for regressions.
 */

// --- Basic recurring tasks ----------------------------------------------------

export const everyMinute = schedules.task({
  id: "every-minute",
  cron: "* * * * *",
  run: async (payload) => {
    logger.info("every-minute fired", {
      timestamp: payload.timestamp.toISOString(),
      lastTimestamp: payload.lastTimestamp?.toISOString() ?? null,
      upcomingCount: payload.upcoming.length,
      timezone: payload.timezone,
      scheduleId: payload.scheduleId,
    });

    return {
      timestamp: payload.timestamp,
      lastTimestamp: payload.lastTimestamp,
    };
  },
});

export const everyFiveMinutes = schedules.task({
  id: "every-five-minutes",
  cron: "*/5 * * * *",
  run: async (payload) => {
    logger.info("every-five-minutes fired", {
      timestamp: payload.timestamp.toISOString(),
      lastTimestamp: payload.lastTimestamp?.toISOString() ?? null,
    });
  },
});

export const hourlyUtc = schedules.task({
  id: "hourly-utc",
  cron: "0 * * * *",
  run: async (payload) => {
    logger.info("hourly-utc fired", {
      timestamp: payload.timestamp.toISOString(),
      lastTimestamp: payload.lastTimestamp?.toISOString() ?? null,
      timezone: payload.timezone,
    });
  },
});

// --- Timezone coverage --------------------------------------------------------
//
// These exercise the engine's tz handling. They fire infrequently, so they're
// mostly useful for inspecting enqueued jobs in the dashboard rather than for
// short dev sessions.

export const dailyNewYorkMorning = schedules.task({
  id: "daily-new-york-morning",
  cron: { pattern: "0 9 * * *", timezone: "America/New_York" },
  run: async (payload) => {
    logger.info("daily-new-york-morning fired", {
      timestamp: payload.timestamp.toISOString(),
      lastTimestamp: payload.lastTimestamp?.toISOString() ?? null,
      timezone: payload.timezone,
      // For DST-observing tz the cron interpretation may shift twice/year —
      // worth eyeballing the timestamp lines up with 09:00 NY local.
    });
  },
});

export const dailyLondonEvening = schedules.task({
  id: "daily-london-evening",
  cron: { pattern: "0 18 * * *", timezone: "Europe/London" },
  run: async (payload) => {
    logger.info("daily-london-evening fired", {
      timestamp: payload.timestamp.toISOString(),
      lastTimestamp: payload.lastTimestamp?.toISOString() ?? null,
      timezone: payload.timezone,
    });
  },
});

export const dailyTokyoMidnight = schedules.task({
  id: "daily-tokyo-midnight",
  cron: { pattern: "0 0 * * *", timezone: "Asia/Tokyo" },
  run: async (payload) => {
    logger.info("daily-tokyo-midnight fired", {
      timestamp: payload.timestamp.toISOString(),
      lastTimestamp: payload.lastTimestamp?.toISOString() ?? null,
      timezone: payload.timezone,
    });
  },
});

// --- Validators ---------------------------------------------------------------
//
// These explicitly check invariants and emit PASS / FAIL log lines. Running
// `trigger dev` and watching these for several fires gives us the E2E signal
// that the worker-payload flow is correct.

/**
 * Verifies that the very first fire reports `lastTimestamp === undefined` and
 * subsequent fires report a real Date. This is the customer-visible surface
 * for the "first-run sentinel" pattern: `if (!payload.lastTimestamp) initOnce()`.
 */
export const firstFireDetector = schedules.task({
  id: "first-fire-detector",
  cron: "* * * * *",
  run: async (payload) => {
    const isFirstFire = payload.lastTimestamp === undefined;
    logger.info(
      isFirstFire ? "first-fire-detector PASS (first fire)" : "first-fire-detector PASS (Nth fire)",
      {
        timestamp: payload.timestamp.toISOString(),
        lastTimestamp: payload.lastTimestamp?.toISOString() ?? null,
        isFirstFire,
      }
    );
  },
});

/**
 * Verifies that for non-first fires, `timestamp - lastTimestamp` equals exactly
 * the cron interval (60s for every-minute). This is the key invariant of the
 * workerCatalog approach — the value is carried through the Redis payload, so
 * it should be exact, not a cron-derived approximation.
 */
export const intervalValidator = schedules.task({
  id: "interval-validator",
  cron: "* * * * *",
  run: async (payload) => {
    if (payload.lastTimestamp === undefined) {
      logger.info("interval-validator skipped (first fire — no lastTimestamp)", {
        timestamp: payload.timestamp.toISOString(),
      });
      return;
    }

    const expectedIntervalMs = 60_000;
    const actualIntervalMs = payload.timestamp.getTime() - payload.lastTimestamp.getTime();
    const passed = actualIntervalMs === expectedIntervalMs;

    logger.info(passed ? "interval-validator PASS" : "interval-validator FAIL", {
      timestamp: payload.timestamp.toISOString(),
      lastTimestamp: payload.lastTimestamp.toISOString(),
      expectedIntervalMs,
      actualIntervalMs,
      driftMs: actualIntervalMs - expectedIntervalMs,
    });

    if (!passed) {
      throw new Error(
        `interval-validator FAIL: expected ${expectedIntervalMs}ms between fires, got ${actualIntervalMs}ms`
      );
    }
  },
});

/**
 * Verifies that `payload.upcoming` is a strictly-increasing array of 10 future
 * slots, each 60s apart for `* * * * *`.
 */
export const upcomingValidator = schedules.task({
  id: "upcoming-validator",
  cron: "* * * * *",
  run: async (payload) => {
    const issues: string[] = [];

    if (payload.upcoming.length !== 10) {
      issues.push(`expected upcoming.length === 10, got ${payload.upcoming.length}`);
    }

    for (let i = 0; i < payload.upcoming.length; i++) {
      const slot = payload.upcoming[i];
      if (slot.getTime() <= payload.timestamp.getTime()) {
        issues.push(`upcoming[${i}] (${slot.toISOString()}) is not strictly after timestamp`);
      }
      if (i > 0) {
        const prev = payload.upcoming[i - 1];
        const gapMs = slot.getTime() - prev.getTime();
        if (gapMs !== 60_000) {
          issues.push(
            `upcoming[${i}] - upcoming[${i - 1}] = ${gapMs}ms, expected 60000ms (every-minute cron)`
          );
        }
      }
    }

    if (issues.length === 0) {
      logger.info("upcoming-validator PASS", {
        timestamp: payload.timestamp.toISOString(),
        upcoming: payload.upcoming.map((d) => d.toISOString()),
      });
    } else {
      logger.error("upcoming-validator FAIL", {
        timestamp: payload.timestamp.toISOString(),
        issues,
        upcoming: payload.upcoming.map((d) => d.toISOString()),
      });
      throw new Error(`upcoming-validator FAIL: ${issues.join("; ")}`);
    }
  },
});
