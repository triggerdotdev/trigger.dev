import type { AuditLogEventSummary, AuditLogEventSummaryQuery } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import {
  auditLogFilters,
  auditLogQuery,
  AuditLogSearchParams,
} from "~/presenters/v3/AuditLogPresenter.server";
import { auditLogCredentialSummary } from "~/presenters/v3/AuditLogSummaryPresenter.server";

// The audit log page's credential summary: when it's asked for, and that it sums up the same
// events the list shows. The plugin is a function that records queries.

const SUMMARY: AuditLogEventSummary = {
  eventCount: 37,
  firstSeenAt: new Date("2026-11-04T10:00:00Z"),
  lastSeenAt: new Date("2026-11-19T14:02:00Z"),
  ipCount: 1,
  countryCodes: ["GB"],
  countryCount: 1,
  recentIps: [],
  approximate: false,
};

function recordingSummarizer(result: AuditLogEventSummary | null | Error = SUMMARY) {
  const queries: AuditLogEventSummaryQuery[] = [];
  const summarize = async (query: AuditLogEventSummaryQuery) => {
    queries.push(query);
    if (result instanceof Error) throw result;
    return result;
  };
  return { summarize, queries };
}

const resultFor = (params: Record<string, string>, summarize = recordingSummarizer()) =>
  auditLogCredentialSummary(
    "org_1",
    AuditLogSearchParams.parse(params),
    summarize.summarize,
    async () => null
  );
const summaryFor = async (params: Record<string, string>, summarize = recordingSummarizer()) =>
  (await resultFor(params, summarize)).summary;

describe("audit log credential summary", () => {
  // Catches: a summary query for every page view, when only one credential's activity is wanted.
  it("is only asked for when the page is filtered to one credential", async () => {
    const summarizer = recordingSummarizer();
    for (const params of [{}, { actor: "user_1" }, { credential: "nope:1" }, { key: "k9Q" }]) {
      expect(await summaryFor(params, summarizer), JSON.stringify(params)).toBeNull();
    }
    expect(summarizer.queries).toEqual([]);

    expect(await summaryFor({ credential: "key:apikey_1" })).toEqual(SUMMARY);
    expect(await summaryFor({ credential: "root:env_1:k9Qz" })).toEqual(SUMMARY);
    expect(await summaryFor({ key: "tr_prod_abcdk9Qz" })).toEqual(SUMMARY);
  });

  // Catches: the summary covering other events than the list: another time range, category,
  // reads, source, or credential.
  it("sums up the events the list shows", async () => {
    const params = {
      credential: "root:env_1:k9Qz",
      category: "envvars",
      reads: "1",
      via: "api",
      period: "7d",
    };
    const summarizer = recordingSummarizer();
    await summaryFor(params, summarizer);

    const searchParams = AuditLogSearchParams.parse(params);
    const {
      cursor: _cursor,
      limit: _limit,
      from: _from,
      to: _to,
      ...listed
    } = auditLogQuery("org_1", auditLogFilters(searchParams), searchParams);
    const [query] = summarizer.queries;
    expect(query).toMatchObject({
      ...listed,
      credential: { kinds: ["root_api_key", "public_jwt"], id: "env_1", last4: "k9Qz" },
    });
    expect(query).not.toHaveProperty("cursor");
    expect(query).not.toHaveProperty("limit");
    // The last 7 days, ending now.
    expect(query!.to.getTime() - query!.from.getTime()).toBe(7 * 24 * 3_600_000);
    expect(Math.abs(query!.to.getTime() - Date.now())).toBeLessThan(60_000);
  });

  // Catches: an empty summary drawn over an empty list, or a failed summary breaking the page.
  it("shows nothing when nothing matches, the range is empty, or the summary fails", async () => {
    const credential = { credential: "key:apikey_1" };
    expect(
      await summaryFor(credential, recordingSummarizer({ ...SUMMARY, eventCount: 0 }))
    ).toBeNull();
    expect(await summaryFor(credential, recordingSummarizer(null))).toBeNull();
    expect(
      await summaryFor(credential, recordingSummarizer(new Error("ClickHouse error 241")))
    ).toBeNull();

    const reversed = recordingSummarizer();
    expect(
      await summaryFor({ ...credential, from: "2026-11-10", to: "2026-11-01" }, reversed)
    ).toBeNull();
    expect(reversed.queries).toEqual([]);

    // Only an answer that nothing matches says there were no events; a failure says nothing.
    expect(
      (await resultFor(credential, recordingSummarizer({ ...SUMMARY, eventCount: 0 }))).noEvents
    ).toBe(true);
    expect((await resultFor(credential, recordingSummarizer(null))).noEvents).toBe(false);
    expect(
      (await resultFor(credential, recordingSummarizer(new Error("ClickHouse error 241")))).noEvents
    ).toBe(false);
  });
});
