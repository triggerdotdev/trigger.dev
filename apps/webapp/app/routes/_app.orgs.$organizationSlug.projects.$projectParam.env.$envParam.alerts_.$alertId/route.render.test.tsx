import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AlertActivityTable, type ActivityRowLink } from "~/components/alerts/AlertActivityTable";
import { AlertDetailChart, AlertDetailFilterBar } from "~/components/alerts/AlertDetailChart";
import { AlertDetailSidebar } from "~/components/alerts/AlertDetailSidebar";
import type { HealthBandRow, HealthQuerySeries } from "~/components/alerts/alertSeriesTypes";
import { PreviewChartCard } from "~/components/alerts/PreviewChartCard";
import { DetailChartBlock } from "~/components/primitives/DetailChartBlock";
import { LocaleContextProvider } from "~/components/primitives/LocaleProvider";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { AlertDetail, AlertDetailEvent } from "~/presenters/v3/AlertDetailPresenter.server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { episodeNote, eventEpisodes } from "./eventEpisodes";
import { buildNotifierOptions, parseNotifierKey, validateChatRef } from "./editNotifierOptions";

function evt(type: AlertDetailEvent["type"], at: string): AlertDetailEvent {
  return { id: `${type}_${at}`, type, at: new Date(at), actorId: null, factsSummary: "" };
}

describe("eventEpisodes", () => {
  it("fails when Activity has no Closed episode header (groups with closedBy)", () => {
    const episodes = eventEpisodes([
      evt("resolved", "2026-01-03T00:00:00Z"),
      evt("recovered", "2026-01-02T00:00:00Z"),
      evt("raised", "2026-01-01T00:00:00Z"),
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.closedBy?.type).toBe("resolved");
    expect(episodes[0]!.entries).toHaveLength(2);
  });

  it("fails when the recovery row is missing for an open recovered episode", () => {
    const episodes = eventEpisodes([
      evt("recovered", "2026-01-02T00:00:00Z"),
      evt("raised", "2026-01-01T00:00:00Z"),
    ]);
    const open = episodes.find((e) => !e.closedBy);
    expect(open).toBeDefined();
    expect(open!.entries.some((e) => e.type === "recovered")).toBe(true);
  });

  it("splits multiple episodes on stopped/expired boundaries", () => {
    const episodes = eventEpisodes([
      evt("raised", "2026-01-04T00:00:00Z"),
      evt("stopped", "2026-01-03T00:00:00Z"),
      evt("raised", "2026-01-01T00:00:00Z"),
    ]);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]!.closedBy?.type).toBe("stopped");
    expect(episodes[1]!.closedBy).toBeUndefined();
  });
});

describe("episodeNote", () => {
  afterEach(() => vi.useRealTimers());

  it("fails when the note reads the clock instead of the loader's now", () => {
    const now = new Date("2026-01-01T02:00:00Z");
    const closedBy = evt("resolved", "2026-01-01T00:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const server = episodeNote(closedBy, "Kate", now);
    vi.setSystemTime(new Date("2031-06-01T00:00:00Z"));
    const client = episodeNote(closedBy, "Kate", now);
    expect(server).toBe("resolved about 2 hours ago by Kate");
    expect(client).toBe(server);
  });

  it("fails when a stopped episode drops the actor", () => {
    const note = episodeNote(
      evt("stopped", "2026-01-01T00:00:00Z"),
      "Kate",
      new Date("2026-01-01T02:00:00Z"),
      "Ada"
    );
    expect(note).toBe("stopped about 2 hours ago by Ada");
  });
});

describe("buildNotifierOptions", () => {
  const projectChannels = [
    { id: "chan_1", name: "Slack #alerts", type: "SLACK" },
    { id: "chan_2", name: "Webhook prod", type: "WEBHOOK" },
  ];

  it("offers an unselected project channel", () => {
    const current = [{ key: "channel:chan_1", label: "Slack #alerts" }];
    const options = buildNotifierOptions(projectChannels, current);
    expect(options.find((o) => o.key === "channel:chan_2")).toBeDefined();
  });

  it("fails when saving drops an attached disabled channel", () => {
    const enabled = [{ id: "chan_1", name: "Slack #alerts", type: "SLACK" }];
    const current = [
      { key: "channel:chan_1", label: "Slack #alerts" },
      { key: "channel:chan_disabled", label: "Old webhook" },
    ];
    const options = buildNotifierOptions(enabled, current);
    const disabled = options.find((o) => o.key === "channel:chan_disabled");
    expect(disabled).toBeDefined();
    expect(disabled!.label).toContain("(disabled)");
    expect(disabled!.disabled).toBe(true);
  });
});

describe("parseNotifierKey", () => {
  it("parses a channel key", () => {
    expect(parseNotifierKey("channel:chan_abc")).toEqual({
      type: "channel",
      channelId: "chan_abc",
    });
  });

  it("round-trips chat with userId only (conversationId=project → undefined)", () => {
    const ref = parseNotifierKey("chat:project:user_1");
    expect(ref).toEqual({
      type: "chat",
      conversationId: undefined,
      chatId: undefined,
      userId: "user_1",
    });
  });

  it("round-trips chat with conversationId/chatId only (userId=- → undefined)", () => {
    const ref = parseNotifierKey("chat:conv_abc:-");
    expect(ref).toEqual({
      type: "chat",
      conversationId: "conv_abc",
      chatId: "conv_abc",
      userId: undefined,
    });
  });

  it("round-trips chat with both conversationId and userId", () => {
    const ref = parseNotifierKey("chat:conv_abc:user_1");
    expect(ref).toEqual({
      type: "chat",
      conversationId: "conv_abc",
      chatId: "conv_abc",
      userId: "user_1",
    });
  });

  it("returns null for unrecognized format", () => {
    expect(parseNotifierKey("unknown:foo")).toBeNull();
  });
});

describe("validateChatRef", () => {
  it("rejects a bare chat ref with no userId (chat:project:-)", () => {
    const ref = parseNotifierKey("chat:project:-");
    expect(ref).not.toBeNull();
    const error = validateChatRef(ref as any, "user_1");
    expect(error).toBe("Chat notifier must specify a user");
  });

  it("rejects a foreign userId", () => {
    const ref = parseNotifierKey("chat:project:user_other");
    const error = validateChatRef(ref as any, "user_1");
    expect(error).toBe("Unauthorized chat notifier");
  });

  it("accepts the current user's chat ref", () => {
    const ref = parseNotifierKey("chat:project:user_1");
    const error = validateChatRef(ref as any, "user_1");
    expect(error).toBeNull();
  });

  it("accepts a chat ref with chatId belonging to the current user", () => {
    const ref = parseNotifierKey("chat:chat_abc:user_1");
    const error = validateChatRef(ref as any, "user_1");
    expect(error).toBeNull();
    expect(ref!).toHaveProperty("chatId", "chat_abc");
  });
});

// ResponsiveContainer measures the DOM, so static markup would draw no plot at all.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<any>, { width: 600, height: 200 })
        : null,
  };
});

const NOW = new Date("2026-09-28T17:35:34Z");
const MIN = 60 * 1000;

function makeAlert(overrides: Partial<AlertDetail> = {}): AlertDetail {
  return {
    id: "alert_1",
    name: "Queue depth",
    capabilityKey: "queue.depth",
    capabilityTitle: "Queue depth",
    area: "queues",
    environmentId: "env_1",
    kind: "threshold",
    operator: ">",
    scope: { type: "queue", queue: "emails" },
    scopeSummary: "Queues · Queue emails",
    conditionSummary: "depth > 5",
    compiledQuery: "SELECT 1",
    windowSec: 300,
    behaviorSummary: "Recurring",
    behaviorLabel: "Recurring",
    status: { status: "needs_attention" },
    channelIssues: [],
    evaluated: true,
    resolvedByLabel: null,
    stoppedByLabel: null,
    notifiers: [{ key: "channel:c1", label: "Slack #alerts" }],
    events: [
      {
        id: "e1",
        type: "raised",
        at: new Date("2026-09-28T16:40:34Z"),
        actorId: null,
        factsSummary: "7 vs 5",
      },
    ],
    occurrenceCount: 4,
    countSinceRaise: 4,
    firstEventAt: new Date("2026-09-28T16:40:34Z"),
    lastEventAt: new Date("2026-09-28T16:40:34Z"),
    canActivate: true,
    unitSuffix: "",
    reading: { value: 3, threshold: 5 },
    stateOutcome: null,
    episode: { raisedAt: new Date(NOW.getTime() - 55 * MIN), recoveredAt: null, outcome: "raised" },
    currentReading: { status: "unavailable", observedAt: NOW },
    factsComponents: null,
    effectiveParams: [],
    ...overrides,
  };
}

function render(node: React.ReactNode) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <OperatingSystemContextProvider platform="mac">
          <ShortcutsProvider>
            <LocaleContextProvider locales={["en-US"]}>{node}</LocaleContextProvider>
          </ShortcutsProvider>
        </OperatingSystemContextProvider>
      ),
    },
  ]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

function sidebar(alert: AlertDetail) {
  return render(<AlertDetailSidebar alert={alert} environmentTitle="Production" />);
}

function between(html: string, start: string, end: string) {
  return html.slice(html.indexOf(start), html.indexOf(end));
}

describe("AlertDetailSidebar", () => {
  it("fails when status text returns under the badge", () => {
    const status = between(
      sidebar(
        makeAlert({
          status: { status: "inactive", reason: "stopped" },
          stoppedByLabel: "Ada",
        } as Partial<AlertDetail>)
      ),
      "Alert status",
      "Condition"
    );
    expect(status).not.toContain("Stopped by");
  });

  it("fails when the status row is a bordered badge with episode text", () => {
    const status = between(sidebar(makeAlert()), "Alert status", "Condition");
    expect(status).toContain("system:bg-error system:text-white");
    expect(status).toContain("rounded px-2 py-0.5");
    expect(status).toContain("Needs attention");
    expect(status).not.toContain("(raised");
    expect(status).not.toContain("border-border-bright");
  });

  it("fails when Mark Alert As is not at the end of the status row", () => {
    const html = render(
      <AlertDetailSidebar
        alert={makeAlert()}
        environmentTitle="Production"
        statusAction={<button type="button">Mark Alert As</button>}
      />
    );
    const status = between(html, "Alert status", "Condition");
    expect(status).toContain("justify-between");
    expect(status).toContain("Mark Alert As");
    expect(status.indexOf("Needs attention")).toBeLessThan(status.indexOf("Mark Alert As"));
    expect(between(html, "Condition", "Notify")).not.toContain("Mark Alert As");
  });

  it("fails when the rows are out of the prototype order", () => {
    const html = sidebar(makeAlert());
    const labels = [
      "Alert status",
      "Condition",
      "Scope",
      "Query",
      ">ID<",
      "Current",
      "Raised",
      "First event",
      "Last event",
      "Behavior",
      "Notify",
    ];
    const positions = labels.map((label) => html.indexOf(label));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("flags a deleted channel as a warning badge without an issue line", () => {
    const html = sidebar(
      makeAlert({
        notifiers: [{ key: "channel:c1", label: "ops" }],
        channelIssues: [{ channelId: "c1", name: null, reason: "deleted" }],
      })
    );
    expect(html).toContain("bg-warning/10");
    expect(html).toContain("Deleted channel");
    expect(html).not.toContain("ops");
    expect(html).not.toContain("Channel: deleted");
    expect(sidebar(makeAlert())).not.toContain("bg-warning/10");
  });

  it("labels a disabled channel as Disabled channel", () => {
    const html = sidebar(
      makeAlert({
        notifiers: [{ key: "channel:c1", label: "ops" }],
        channelIssues: [{ channelId: "c1", name: "ops", reason: "disabled" }],
      })
    );
    expect(html).toContain("Disabled channel");
    expect(html).not.toContain("ops");
  });

  it("labels the count row per alert kind", () => {
    expect(sidebar(makeAlert())).toContain(">Raised<");
    expect(sidebar(makeAlert({ kind: "occurrence" }))).toContain(">Occurrences<");
  });

  it("fails when the query block is unwrapped before highlighting loads", () => {
    const query = between(sidebar(makeAlert()), "Query", ">ID<");
    expect(query).toContain("[&amp;_pre]:whitespace-pre-wrap");
  });

  it("fails when a missing reading renders a dash or zero", () => {
    const current = between(sidebar(makeAlert({ reading: null })), "Current", "Raised");
    expect(current).toContain("No current reading.");
    expect(current).not.toContain("—");
  });
});

describe("PreviewChartCard", () => {
  it("fails when the title and info icon are not gap-1 like the concurrency header", () => {
    const html = render(
      <PreviewChartCard title="Queue depth" info="Info text">
        <div />
      </PreviewChartCard>
    );
    expect(html).toMatch(/<span class="flex items-center gap-1">Queue depth/);
    expect(html).not.toContain("gap-3");
    expect(html).toContain("flex items-baseline gap-2");
  });
});

describe("AlertActivityTable", () => {
  const link: ActivityRowLink = { to: "/runs", label: "View related runs", kind: "runs" };

  it("fails when the time is relative or facts are inline", () => {
    const html = render(<AlertActivityTable alert={makeAlert()} now={NOW} rowLink={() => link} />);
    expect(html).toContain("Sep 28, 2026, 4:40:34 PM");
    expect(html).toContain('title="7 vs 5"');
    const eventCell = html.slice(html.indexOf("Sep 28, 2026")).match(/Raised(<| )/);
    expect(eventCell?.[0]).toBe("Raised<");
    expect(html).not.toContain(">7 vs 5<");
  });

  it("fails when the related-runs control is always visible text", () => {
    const html = render(<AlertActivityTable alert={makeAlert()} now={NOW} rowLink={() => link} />);
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toMatch(/group-hover:opacity-100">\s*<a [^>]*href="\/runs"/);
    expect(html).toContain("aspect-square");
    expect(html).toContain('aria-label="View related runs"');
  });
});

describe("AlertDetailFilterBar", () => {
  it("fails when the Occurred time filter is missing", () => {
    expect(render(<AlertDetailFilterBar />)).toContain("Occurred");
  });

  it("fails when the lifetime window is labelled as the 7d default", () => {
    const lifetime = {
      since: new Date("2026-01-01T00:00:00Z"),
      until: new Date("2026-01-02T00:00:00Z"),
    };
    const html = render(<AlertDetailFilterBar lifetime={lifetime} />);
    expect(html).toContain("Jan 1");
    expect(html).not.toContain("7 days");
  });
});

describe("AlertDetailChart state", () => {
  const until = new Date("2026-09-28T16:00:00Z");
  const raisedEpisode = {
    raisedAt: new Date(until.getTime() - 60 * MIN),
    recoveredAt: null,
    outcome: "raised" as const,
  };
  const component = { outcome: "met" as const, effectiveParams: {} };

  function chart(
    overrides: Partial<AlertDetail>,
    healthBands: HealthBandRow[] = [],
    componentSeries: HealthQuerySeries[] = []
  ) {
    return render(
      <AlertDetailChart
        alert={makeAlert({
          kind: "state",
          capabilityKey: "health.all",
          events: [],
          ...overrides,
        })}
        metricSeriesMap={new Map()}
        healthBands={healthBands}
        componentSeries={componentSeries}
        window={{ since: new Date(until.getTime() - 7 * 24 * 60 * MIN), until }}
        now={until}
      />
    );
  }

  const curveYs = (html: string) =>
    [...(html.match(/recharts-line-curve" d="([^"]*)"/)?.[1] ?? "").matchAll(/,([\d.]+)/g)].map(
      (m) => Number(m[1])
    );

  const healthyBands: HealthBandRow[] = [8, 4].map((h) => ({
    bucket: until.getTime() - h * 60 * MIN,
    degraded: null,
    healthy: 1,
    unknown: null,
  }));

  const healthyReference = () =>
    curveYs(
      chart({ episode: { raisedAt: null, recoveredAt: null, outcome: null } }, healthyBands)
    )[0]!;

  const expectHealthyTail = (html: string) => {
    const ys = curveYs(html);
    expect(ys.length).toBeGreaterThan(1);
    for (const y of ys.slice(-2)) expect(y).toBe(healthyReference());
  };

  it("fails when the chart block is not the wrapper the Errors detail page uses", () => {
    const wrapper = render(<DetailChartBlock toolbar={null}>{null}</DetailChartBlock>);
    const html = chart({});
    expect(html).toContain('data-testid="detail-chart-block"');
    expect(html).toContain(wrapper.match(/class="([^"]*)"/)![1]!);
    const errorsRoute = readFileSync(
      join(
        __dirname,
        "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.errors.$fingerprint/route.tsx"
      ),
      "utf8"
    );
    expect(errorsRoute).toContain("<DetailChartBlock");
  });

  it("fails when a raised state alert without events shows no degraded tail", () => {
    const html = chart({ episode: raisedEpisode });
    expect(html).toContain("Environment status");
    expect(html).not.toContain("No activity yet");
    const healthyY = healthyReference();
    const ys = curveYs(html);
    expect(ys.length).toBeGreaterThan(1);
    for (const y of ys.slice(-2)) expect(y).toBeGreaterThan(healthyY);
  });

  const lastBand: HealthBandRow = {
    bucket: until.getTime() - 4 * 60 * MIN,
    degraded: 1,
    healthy: null,
    unknown: null,
  };

  it("fails when an inactive one-band chart loses its flat segment", () => {
    const ys = curveYs(
      chart({ status: { status: "inactive", reason: "stopped" }, episode: raisedEpisode }, [
        lastBand,
      ])
    );
    expect(ys.length).toBeGreaterThan(1);
    expect(new Set(ys).size).toBe(1);
  });

  it("fails when a cleared alert without a recovered event ends degraded", () => {
    const ys = curveYs(
      chart(
        {
          status: { status: "active" },
          evaluated: true,
          episode: { raisedAt: raisedEpisode.raisedAt, recoveredAt: null, outcome: null },
        },
        [lastBand]
      )
    );
    expect(ys[ys.length - 1]).toBeLessThan(ys[0]!);
  });

  it("fails when a clear alert with a met component paints a degraded tail", () => {
    const html = chart(
      {
        status: { status: "active" },
        episode: { raisedAt: null, recoveredAt: null, outcome: null },
        factsComponents: {
          flow: component,
          execution: { ...component, outcome: "not_met" },
          liveness: { ...component, outcome: "not_met" },
        },
      },
      healthyBands
    );
    expectHealthyTail(html);
  });

  it("fails when a stopped alert keeps a degraded tail", () => {
    const html = chart(
      { status: { status: "inactive", reason: "stopped" }, episode: raisedEpisode },
      healthyBands
    );
    expectHealthyTail(html);
  });

  it("fails when the Health/Metrics toggle shows without query series", () => {
    const querySeries: HealthQuerySeries[] = [
      { key: "silenceSec", label: "Silence", threshold: 300, points: [] },
      { key: "failureRatePct", label: "Failure rate", threshold: 5, points: [] },
    ];
    expect(chart({}, healthyBands)).not.toContain("Metrics");
    const html = chart({}, healthyBands, querySeries);
    expect(html).toContain("Health");
    expect(html).toContain("Metrics");
    expect(html).toContain(">Healthy<");
    expect(chart({}, healthyBands, querySeries.slice(0, 1))).not.toContain("Health chart view");
  });

  it("fails when the chart height, paddings or toggle placement regress", () => {
    const querySeries: HealthQuerySeries[] = [
      { key: "silenceSec", label: "Silence", threshold: 300, points: [] },
      { key: "failureRatePct", label: "Failure rate", threshold: 5, points: [] },
    ];
    const html = chart({}, healthyBands, querySeries);
    expect(html).toContain("min-h-[210px] flex-1");
    expect(html).toContain("min-h-0 flex-1 pr-2");
    expect(html).not.toContain("min-h-0 flex-1 px-2");
    expect(html).toContain("drag-handle mb-3 flex items-start justify-between gap-2 pl-1");
    expect(html).not.toContain("pl-4 pr-3");
    const header = html.slice(html.indexOf("drag-handle"));
    const toggle = header.indexOf('aria-label="Health chart view"');
    const maximize = header.indexOf('aria-label="Maximize chart"');
    expect(toggle).toBeGreaterThan(-1);
    expect(toggle).toBeLessThan(maximize);
    const toolbar = html.slice(0, html.indexOf("drag-handle"));
    expect(toolbar).not.toContain("Health chart view");
  });
});

describe("absence silence", () => {
  it("fails when the header and the legend measure the silence from different starts", () => {
    const HOUR = 60 * MIN;
    const start = NOW.getTime() - 24 * HOUR;
    const series = Array.from({ length: 24 }, (_, i) => ({ bucket: start + i * HOUR, value: 2 }));
    const alert = makeAlert({
      kind: "absence",
      windowSec: 300,
      episode: {
        raisedAt: new Date(NOW.getTime() - 35 * MIN),
        recoveredAt: null,
        outcome: "raised",
      },
    });
    const html = render(
      <AlertDetailChart
        alert={alert}
        metricSeriesMap={new Map([["__agg__", series]])}
        healthBands={[]}
        window={{ since: new Date(start), until: NOW }}
        now={NOW}
      />
    );
    expect(html).toContain("Quiet");
  });
});

describe("AlertDetailChart starts at the first available data", () => {
  const HOUR = 60 * MIN;
  const start = NOW.getTime() - 24 * HOUR;
  const window = { since: new Date(start), until: NOW };
  const at = (i: number) => start + i * HOUR;
  const quiet = { raisedAt: null, recoveredAt: null, outcome: null };

  const shapes = (html: string) =>
    [...html.matchAll(/recharts-(?:line-curve|rectangle|reference-area-rect)"[^>]*/g)].map((m) =>
      m[0].replace(/ (?:id|clip-path)="[^"]*"/g, "")
    );

  function chart(
    overrides: Partial<AlertDetail>,
    data: {
      metric?: { bucket: number; value: number | null }[];
      bands?: HealthBandRow[];
    },
    createdAt?: Date
  ) {
    return render(
      <AlertDetailChart
        alert={makeAlert({ events: [], episode: quiet, ...overrides })}
        metricSeriesMap={new Map(data.metric ? [["__agg__", data.metric]] : [])}
        healthBands={data.bands ?? []}
        window={window}
        now={NOW}
        createdAt={createdAt}
      />
    );
  }

  it("fails when the threshold legend swatch differs from the line colour", () => {
    const metric = Array.from({ length: 4 }, (_, i) => ({ bucket: at(i), value: i }));
    const html = chart({}, { metric });
    const line = html.match(/stroke="([^"]+)"[^>]*recharts-line-curve/)?.[1];
    expect(line).toBeDefined();
    expect(html).toContain(`background-color:${line}`);
    expect(html).not.toContain("--color-queues-chart");
  });

  it("fails when a leading null run is plotted", () => {
    const metric = Array.from({ length: 24 }, (_, i) => ({
      bucket: at(i),
      value: i < 10 ? null : i,
    }));
    const html = chart({}, { metric });
    expect(shapes(html).length).toBeGreaterThan(0);
    expect(shapes(html)).toEqual(shapes(chart({}, { metric: metric.slice(10) })));
  });

  it("fails when health bands before the first known state are plotted", () => {
    const bands: HealthBandRow[] = Array.from({ length: 12 }, (_, i) => ({
      bucket: at(2 * i),
      degraded: null,
      healthy: i >= 6 ? 1 : null,
      unknown: i >= 6 ? null : 1,
    }));
    const state = { kind: "state" as const, capabilityKey: "health.all" };
    const html = chart(state, { bands });
    expect(shapes(html).length).toBeGreaterThan(0);
    expect(shapes(html)).toEqual(shapes(chart(state, { bands: bands.slice(6) })));
  });

  it("fails when a young absence alert collapses to one bar", () => {
    const since = NOW.getTime() - 5 * HOUR;
    const bucket = 7 * MIN;
    const metric = Array.from({ length: 43 }, (_, i) => ({ bucket: since + i * bucket, value: 0 }));
    const html = render(
      <AlertDetailChart
        alert={makeAlert({
          kind: "absence",
          windowSec: 3600,
          episode: quiet,
          events: [{ ...makeAlert().events[0]!, at: new Date(since + 42 * bucket) }],
        })}
        metricSeriesMap={new Map([["__agg__", metric]])}
        healthBands={[]}
        window={{ since: new Date(since), until: NOW }}
        now={NOW}
        createdAt={new Date(since)}
      />
    );
    expect(html).toContain("recharts-reference-area-rect");
    expect(html.match(/recharts-cartesian-axis-tick-value/g)!.length).toBeGreaterThan(2);
  });

  it("fails when the quiet band keeps pre-slice indices", () => {
    const metric = Array.from({ length: 24 }, (_, i) => ({
      bucket: at(i),
      value: i >= 6 && i < 12 ? 2 : 0,
    }));
    const absence = { kind: "absence" as const, windowSec: 3600 };
    const html = chart(absence, { metric }, new Date(at(6)));
    expect(html).toContain("recharts-reference-area-rect");
    expect(shapes(html)).toEqual(shapes(chart(absence, { metric: metric.slice(6) })));
  });

  it("fails when zero-filled buckets before creation are plotted", () => {
    const metric = Array.from({ length: 24 }, (_, i) => ({ bucket: at(i), value: i >= 8 ? 1 : 0 }));
    const occurrence = { kind: "occurrence" as const };
    const html = chart(occurrence, { metric }, new Date(at(8) + 30 * MIN));
    expect(shapes(html).length).toBeGreaterThan(0);
    expect(shapes(html)).toEqual(shapes(chart(occurrence, { metric: metric.slice(8) })));
  });

  it("fails when an occurrence bucket aligned before the window is not drawn", () => {
    const metric = [{ bucket: start - 20 * MIN, value: 1 }];
    const html = chart({ kind: "occurrence" as const }, { metric });
    expect(html).not.toContain("No data");
    expect(shapes(html).length).toBeGreaterThan(0);
  });
});
