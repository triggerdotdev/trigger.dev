import { describe, expect, it } from "vitest";
import {
  alertDetailWindow,
  detailHealthBands,
  firstDataAt,
  healthEventsForBands,
  sliceFrom,
} from "./alertDetailWindow";
import { buildHealthBands, type HealthBandRow } from "./alertSeriesTypes";
import { windowBucketSeconds } from "~/v3/services/alerts/alertSeries.server";
import { healthBucketMs } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts_.$alertId/healthBucketMs.server";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const lifetime = { since: new Date("2026-01-01"), until: new Date("2026-01-02") };

describe("alertDetailWindow", () => {
  it("fails when period=1h is ignored", () => {
    const window = alertDetailWindow({ period: "1h" }, lifetime);
    expect(window.until.getTime() - window.since.getTime()).toBe(HOUR);
    expect(window.isLifetime).toBe(false);
  });

  it("keeps the lifetime window without params and defaults active alerts to 7d", () => {
    expect(alertDetailWindow({}, lifetime)).toEqual({ ...lifetime, isLifetime: true });
    const active = alertDetailWindow({}, undefined);
    expect(active.until.getTime() - active.since.getTime()).toBe(7 * DAY);
  });

  it("fails when an invalid period overrides the lifetime window", () => {
    expect(alertDetailWindow({ period: "banana" }, lifetime)).toEqual({
      ...lifetime,
      isLifetime: true,
    });
  });

  it("fails when a to-only window starts after it ends", () => {
    const to = new Date("2020-01-01T00:00:00Z").getTime();
    const window = alertDetailWindow({ to }, undefined);
    expect(window.until.getTime()).toBe(to);
    expect(window.since.getTime()).toBe(to - 7 * DAY);
  });
});

describe("alertDetailWindow from creation", () => {
  it("fails when an active alert's window is not clamped to createdAt", () => {
    const createdAt = new Date(Date.now() - 5 * HOUR);
    const window = alertDetailWindow({ period: "7d" }, undefined, createdAt);
    expect(window.since).toEqual(createdAt);
    const bucketMs = windowBucketSeconds(window, 60) * 1000;
    expect((window.until.getTime() - window.since.getTime()) / bucketMs).toBeGreaterThanOrEqual(12);
  });

  it("keeps the lifetime window of an inactive alert", () => {
    expect(alertDetailWindow({}, lifetime, new Date("2026-01-01T12:00:00Z"))).toEqual({
      ...lifetime,
      isLifetime: true,
    });
  });
});

describe("detail health bucket size", () => {
  const bandsFor = (span: number) => {
    const until = Date.UTC(2026, 0, 8);
    const window = { since: new Date(until - span), until: new Date(until) };
    return buildHealthBands([], until, until - span, healthBucketMs(window, 300));
  };

  it("fails when a short window keeps 4h health buckets", () => {
    const bands = bandsFor(5 * HOUR);
    expect(bands.length).toBeGreaterThanOrEqual(10);
    expect(bands[1]!.bucket - bands[0]!.bucket).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it("keeps 4h health buckets for the 7d default", () => {
    const bands = bandsFor(7 * DAY);
    expect(bands[1]!.bucket - bands[0]!.bucket).toBe(4 * HOUR);
  });
});

describe("healthEventsForBands", () => {
  it("fails when a raised/recovered pair without findings draws no degraded bucket", () => {
    const until = Date.UTC(2026, 8, 28);
    const events = healthEventsForBands([
      { type: "recovered", at: new Date(until - 20 * HOUR), facts: {} },
      { type: "raised", at: new Date(until - 30 * HOUR), facts: {} },
      { type: "stopped", at: new Date(until - 25 * HOUR), facts: {} },
    ]);
    const bands = buildHealthBands(events, until, until - 7 * DAY);
    expect(bands.some((b) => b.degraded === 1)).toBe(true);
    expect(bands[bands.length - 1]!.degraded).toBeNull();
  });
});

describe("health bands from real state events", () => {
  it("fails when a degraded stretch shorter than a bucket collapses to healthy", () => {
    const until = Date.parse("2026-09-30T15:30:00Z");
    const events = healthEventsForBands([
      {
        type: "recovered",
        at: new Date("2026-09-30T14:29:53.590Z"),
        facts: { value: 0, bucketSec: 600, windowSec: 600 },
      },
      { type: "raised", at: new Date("2026-09-30T12:49:06.248Z"), facts: {} },
    ]);
    const bands = buildHealthBands(events, until, until - 7 * DAY);
    expect(bands.filter((b) => b.degraded === 1).length).toBeGreaterThan(0);
  });
});

describe("health bands for an active alert", () => {
  const until = Date.UTC(2026, 0, 3);
  const since = until - 48 * HOUR;
  const createdAt = until - 10 * HOUR;

  it("is healthy from creation until the first event", () => {
    const bands = buildHealthBands([], until, since, 2 * HOUR, createdAt);
    for (const b of bands) {
      const created = b.bucket + 2 * HOUR > createdAt;
      expect(created ? b.healthy : b.unknown).toBe(1);
    }
  });

  it("is healthy before the first raise and degraded after it", () => {
    const raisedAt = until - 5 * HOUR;
    const events = healthEventsForBands([{ type: "raised", at: new Date(raisedAt), facts: {} }]);
    const bands = buildHealthBands(events, until, since, 2 * HOUR, createdAt);
    for (const b of bands.filter((b) => b.bucket + 2 * HOUR > createdAt)) {
      expect(b.bucket + 2 * HOUR < raisedAt ? b.healthy : b.degraded).toBe(1);
    }
  });

  it("keeps a degraded seed from before the window over healthySince", () => {
    const events = healthEventsForBands([
      { type: "raised", at: new Date(since - 5 * HOUR), facts: {} },
    ]);
    const bands = buildHealthBands(events, until, since, 2 * HOUR, since - 20 * HOUR);
    expect(bands.every((b) => b.degraded === 1)).toBe(true);
  });
});

describe("firstDataAt", () => {
  const since = Date.UTC(2026, 0, 1);
  const window = { since: new Date(since), until: new Date(since + 24 * HOUR) };
  const at = (i: number) => since + i * HOUR;
  const series = Array.from({ length: 24 }, (_, i) => ({
    bucket: at(i),
    value: i < 10 ? null : 5,
  }));

  it("fails when leading null buckets are kept", () => {
    expect(firstDataAt(window, undefined, { series: [series] })).toBe(at(10));
  });

  it("fails when the start is not clamped to createdAt", () => {
    const createdAt = new Date(at(14) + 30 * 60 * 1000);
    const start = firstDataAt(window, createdAt, { series: [series] });
    expect(start).toBe(createdAt.getTime());
    expect(sliceFrom(series, start)[0]!.bucket).toBe(at(14));
  });

  it("fails when unknown health bands start the chart", () => {
    const bands: HealthBandRow[] = Array.from({ length: 12 }, (_, i) => ({
      bucket: at(i),
      degraded: null,
      healthy: i >= 6 ? 1 : null,
      unknown: i >= 6 ? null : 1,
    }));
    const start = firstDataAt(window, undefined, { bands });
    expect(start).toBe(at(6));
    expect(sliceFrom(bands, start)).toEqual(bands.slice(6));
  });

  it("fails when real zero readings are skipped", () => {
    const gauge = series.map((p, i) => ({ ...p, value: i < 3 ? 0 : 5 }));
    expect(firstDataAt(window, new Date(since - HOUR), { series: [gauge] })).toBe(since);
  });

  it("fails when an alert without data loses the window start", () => {
    expect(firstDataAt(window, undefined, { series: [series.slice(0, 10)] })).toBe(since);
  });
});

describe("detailHealthBands without a raise time", () => {
  const until = Date.UTC(2026, 0, 3);
  const window = { since: new Date(until - 8 * HOUR), until: new Date(until) };
  const bands = buildHealthBands([], until, until - 8 * HOUR, 4 * HOUR);
  const run = (live: boolean) => detailHealthBands(bands, window, { now: true, since: null, live });

  it("paints the last band degraded on a live window", () => {
    expect(run(true).filter((b) => b.degraded).length).toBe(1);
  });

  it("paints no band degraded on a historical window", () => {
    expect(run(false).filter((b) => b.degraded).length).toBe(0);
  });
});
