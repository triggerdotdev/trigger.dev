import type { ApiKeyCapabilityCatalogue } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import {
  type ApiKeyUsageView,
  capabilityUsageLine,
  fullAccessCapabilities,
  lossNote,
  narrowToUsage,
} from "~/utils/apiKeyUsage";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 11, 20, 12);
const ago = (days: number) => new Date(now - days * DAY);

const readWrite = (id: string, label: string, resource: string) => ({
  id,
  label,
  levels: [
    { id: "none", label: "None", scopes: [] },
    { id: "read", label: "Read", scopes: [`read:${resource}`] },
    {
      id: "readWrite",
      label: "Read and write",
      scopes: [`read:${resource}`, `write:${resource}`],
    },
  ],
});

const catalogue: ApiKeyCapabilityCatalogue = {
  available: true,
  capabilities: [
    readWrite("runs", "Runs", "runs"),
    readWrite("envvars", "Environment variables", "envvars"),
  ],
};
const [runs] = catalogue.capabilities;

function view(overrides: Partial<ApiKeyUsageView> = {}): ApiKeyUsageView {
  return {
    trackedSince: ago(60),
    windowDays: 30,
    capabilities: {},
    narrowTo: {},
    ...overrides,
  };
}

const used = (daysAgo: number, levelId: string) => ({
  lastUsedAt: ago(daysAgo),
  usedLevelId: levelId,
});

describe("capabilityUsageLine", () => {
  it("gives the time a row was last used", () => {
    expect(
      capabilityUsageLine(runs!, "read", view({ capabilities: { runs: used(12, "read") } }))
    ).toEqual({ label: "Last used", lastUsedAt: ago(12) });
  });

  it("names the level used on a row that grants more", () => {
    expect(
      capabilityUsageLine(runs!, "readWrite", view({ capabilities: { runs: used(0, "read") } }))
    ).toEqual({ label: "Read last used", lastUsedAt: ago(0) });
  });

  it("has no time for a row the store never saw", () => {
    expect(capabilityUsageLine(runs!, "read", view())).toEqual({
      label: "Last used",
      lastUsedAt: null,
    });
  });

  it("keeps the time from before the window", () => {
    expect(
      capabilityUsageLine(
        runs!,
        "readWrite",
        view({ capabilities: { runs: { ...used(41, "read"), usedLevelId: null } } })
      )
    ).toEqual({ label: "Last used", lastUsedAt: ago(41) });
  });

  it("does not name a level on a full-access key", () => {
    expect(
      capabilityUsageLine(runs!, undefined, view({ capabilities: { runs: used(1, "read") } }))
    ).toEqual({ label: "Last used", lastUsedAt: ago(1) });
  });
});

describe("lossNote", () => {
  it("notes what a lost row was used for", () => {
    const usage = view({ capabilities: { runs: used(2, "read") } });
    expect(lossNote(runs!, "read", usage, now)).toBe("still covers what it used");
    expect(lossNote(runs!, "none", usage, now)).toBe("Read used 2 days ago");
    expect(
      lossNote(
        runs!,
        "none",
        view({ capabilities: { runs: { ...used(41, "read"), usedLevelId: null } } }),
        now
      )
    ).toBe("last used 41 days ago");
    expect(lossNote(runs!, "none", view(), now)).toMatch(/^never used since tracking started /);
  });
});

describe("narrowToUsage", () => {
  const narrow = (usage: ApiKeyUsageView, fullAccess = false) =>
    narrowToUsage({
      view: usage,
      catalogue,
      capabilities: { runs: "readWrite", envvars: "read" },
      fullAccess,
    });

  it("offers the plugin's narrowed access", () => {
    expect(narrow(view({ narrowTo: { runs: "read" } }))).toEqual({
      ok: true,
      capabilities: { runs: "read" },
    });
  });

  it("explains each reason it can't narrow", () => {
    expect(
      narrow(
        view({
          narrowTo: null,
          trackedSince: ago(3),
          narrowBlocker: { kind: "tooLittleHistory", trackedDays: 3, minimumDays: 7 },
        })
      )
    ).toEqual({
      ok: false,
      reason: "Narrowing needs 7 days of usage.",
    });
    expect(
      narrow(view({ narrowTo: null, narrowBlocker: { kind: "usedUnrestrictedRoutes" } }), true)
    ).toMatchObject({ ok: false, reason: expect.stringContaining("only full-access keys") });
    expect(
      narrow(
        view({
          narrowTo: null,
          narrowBlocker: { kind: "usedOutsideCatalogue", scopes: ["read:prompts"] },
        })
      )
    ).toEqual({ ok: false, reason: "It used access the grid doesn't cover: read:prompts." });
    expect(narrow(view({ narrowTo: {} }))).toEqual({
      ok: false,
      reason: "It hasn't been used in the last 30 days.",
    });
    expect(narrow(view({ narrowTo: { runs: "readWrite", envvars: "read" } }))).toEqual({
      ok: false,
      reason: "It used all of its access in the last 30 days.",
    });
  });

  it("needs a plan that allows restricted keys", () => {
    expect(
      narrowToUsage({
        view: view({ narrowTo: { runs: "read" } }),
        catalogue: { ...catalogue, available: false },
        capabilities: undefined,
        fullAccess: true,
      })
    ).toMatchObject({ ok: false });
  });
});

it("fullAccessCapabilities picks the top level of each row", () => {
  expect(fullAccessCapabilities(catalogue)).toEqual({ runs: "readWrite", envvars: "readWrite" });
});
