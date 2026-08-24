// The page posts only the flags its UI manages, so the action's reading of an absent key is the
// whole bug surface. These drive the real exported action with the auth wrapper unwrapped, and
// assert on what it hands the writer.
import { describe, expect, it, vi } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";

const { replaceGlobalFeatureFlags } = vi.hoisted(() => ({
  replaceGlobalFeatureFlags: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: (_options: unknown, handler: unknown) => handler,
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("~/v3/featureFlags.server", () => ({
  replaceGlobalFeatureFlags,
  flags: vi.fn().mockResolvedValue({}),
}));
vi.mock("~/db.server", () => ({ prisma: {}, boundedIn: (v: unknown) => v }));

const { action } = await import("~/routes/admin.feature-flags");

async function post(host: string, body: unknown) {
  const request = new Request(`https://${host}/admin/feature-flags`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return (await (action as any)({ request, params: {}, context: {} })) as Response;
}

describe("admin feature flags action", () => {
  it("defaults unlockLockedFlags to false when the field is absent", async () => {
    replaceGlobalFeatureFlags.mockClear();
    const response = await post("localhost:3030", { flags: {} });

    expect(response.status).toBe(200);
    expect(replaceGlobalFeatureFlags).toHaveBeenCalledTimes(1);
    expect(replaceGlobalFeatureFlags.mock.calls[0][1]).toMatchObject({
      unlockLockedFlags: false,
      isManagedCloud: false,
    });
  });

  it("passes unlockLockedFlags through when the page says it unlocked them", async () => {
    replaceGlobalFeatureFlags.mockClear();
    await post("localhost:3030", { flags: {}, unlockLockedFlags: true });

    expect(replaceGlobalFeatureFlags.mock.calls[0][1]).toMatchObject({ unlockLockedFlags: true });
  });

  it("marks a managed cloud host as such", async () => {
    replaceGlobalFeatureFlags.mockClear();
    await post("cloud.trigger.dev", { flags: {}, unlockLockedFlags: true });

    expect(replaceGlobalFeatureFlags.mock.calls[0][1]).toMatchObject({ isManagedCloud: true });
  });

  it("rejects a locked flag submitted to managed cloud without writing", async () => {
    replaceGlobalFeatureFlags.mockClear();
    const response = await post("cloud.trigger.dev", {
      flags: { [FEATURE_FLAG.defaultWorkerInstanceGroupId]: "clwg0001" },
    });

    expect(response.status).toBe(400);
    expect(replaceGlobalFeatureFlags).not.toHaveBeenCalled();
  });

  it("rejects a value that fails the catalog schema without writing", async () => {
    replaceGlobalFeatureFlags.mockClear();
    const response = await post("localhost:3030", {
      flags: { [FEATURE_FLAG.realtimeBackend]: "not-a-backend" },
    });

    expect(response.status).toBe(400);
    expect(replaceGlobalFeatureFlags).not.toHaveBeenCalled();
  });

  it("submits every catalog key so omitted flags are swept", async () => {
    replaceGlobalFeatureFlags.mockClear();
    await post("localhost:3030", { flags: { [FEATURE_FLAG.mollifierEnabled]: true } });

    const { catalogKeys, requestedFlags } = replaceGlobalFeatureFlags.mock.calls[0][1];
    expect(catalogKeys).toContain(FEATURE_FLAG.defaultWorkerInstanceGroupId);
    expect(requestedFlags).toEqual({ [FEATURE_FLAG.mollifierEnabled]: true });
  });
});
