import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDocsKey,
  forgetRejectedKey,
  isDocsKey,
  keepKeysOf,
  keyCreationError,
  pickKey,
  playgroundKey,
  type DocsKey,
} from "./docs-keys";

const key = (name: string, projectRef: string, scopes: string[] | null): DocsKey => ({
  projectRef,
  env: "dev",
  name,
  apiKey: `tr_dev_sk_${name}`,
  apiUrl: "https://api.trigger.dev",
  access: null,
  scopes,
  created: "2026-11-25T00:00:00.000Z",
});

const operator = key("operator", "proj_a", ["trigger:tasks", "read:runs", "write:runs"]);
const envvars = key("envvars", "proj_a", ["read:envvars"]);
const otherProject = key("other", "proj_b", ["read:envvars", "write:envvars"]);

describe("pickKey", () => {
  // Catches: the playground filling a key that can't call the endpoint, or another project's key.
  it("picks the first key for the project that covers what's needed", () => {
    const keys = [operator, envvars, otherProject];
    expect(pickKey(keys, "proj_a", ["read:runs"])).toBe(operator);
    expect(pickKey(keys, "proj_a", ["read:envvars"])).toBe(envvars);
    expect(pickKey(keys, "proj_a", ["write:envvars"])).toBeNull();
    expect(pickKey(keys, "proj_b", ["read:runs"])).toBeNull();
  });

  it("lets an unrestricted key cover anything", () => {
    expect(pickKey([key("full", "proj_a", null)], "proj_a", ["write:schedules"])?.name).toBe(
      "full"
    );
  });
});

describe("createDocsKey errors", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: object, headers: Record<string, string> = {}) =>
    vi.stubGlobal("fetch", async () => Response.json(body, { status, headers }));

  // Catches: readers shown the dashboard's raw "Unauthenticated" / "Not found" / "Failed to fetch".
  it("tells the reader what happened and what to do", async () => {
    reply(401, { error: "Unauthenticated" });
    await expect(createDocsKey("proj_a", null)).rejects.toMatchObject({
      message: "Your dashboard session ended. Sign in again.",
      signIn: true,
    });
    reply(404, { error: "Not found" });
    await expect(createDocsKey("proj_a", null)).rejects.toThrow(
      "You no longer have access to this project. Pick another one."
    );
    reply(404, { error: "No dev environment" });
    await expect(createDocsKey("proj_a", null)).rejects.toThrow(
      /don't have a development environment in this project yet/
    );
    reply(429, { error: "Too many requests" }, { "Retry-After": "1380" });
    await expect(createDocsKey("proj_a", null)).rejects.toThrow(
      "Too many keys created. Try again in 23 minutes."
    );
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(createDocsKey("proj_a", null)).rejects.toThrow(
      "Couldn't reach the dashboard. Try again in a moment."
    );
  });

  it("keeps the role message and falls back when Retry-After is missing", () => {
    expect(keyCreationError(403, "Your role can't grant write:envvars", null).message).toBe(
      "Your role can't grant write:envvars"
    );
    expect(keyCreationError(403, "Forbidden", null).message).toBe(
      "You can't create dev keys in this project."
    );
    expect(keyCreationError(429, undefined, null).message).toBe(
      "Too many keys created. Try again later."
    );
    expect(keyCreationError(429, undefined, "30").message).toMatch(/in a minute/);
    // Access only a full-access key covers: the hint shows "Manage keys" next to this.
    expect(
      keyCreationError(422, "This operation needs a key from the API keys page.", null).message
    ).toBe("This operation needs a key from the API keys page.");
  });
});

describe("forgetRejectedKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Catches: a revoked or expired docs key staying "in use" in samples and the playground.
  it("drops this tab's key on a 401 and leaves other keys and statuses alone", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ name: "Docs key", apiKey: "tr_dev_sk_dead", scopes: null })
    );
    await createDocsKey("proj_a", null);
    expect(forgetRejectedKey(401, "Bearer tr_dev_typed_by_reader")).toBe(false);
    expect(forgetRejectedKey(500, "Bearer tr_dev_sk_dead")).toBe(false);
    expect(isDocsKey("tr_dev_sk_dead")).toBe(true);
    expect(forgetRejectedKey(401, "Bearer tr_dev_sk_dead")).toBe(true);
    // Gone from the store, but still known as a docs key so the playground field can be refilled.
    expect(forgetRejectedKey(401, "Bearer tr_dev_sk_dead")).toBe(false);
    expect(isDocsKey("tr_dev_sk_dead")).toBe(true);
    expect(isDocsKey("tr_dev_typed_by_reader")).toBe(false);
  });
});

describe("playgroundKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Catches: switching to a project without a key leaving the previous project's key in the field,
  // so Send runs in the old project (and a revoked key coming back after a reload).
  it("fills the covering key, clears a docs key nothing covers, and never touches a typed key", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ name: "Docs key", apiKey: "tr_dev_sk_project_a", scopes: null })
    );
    const a = await createDocsKey("proj_a", null);
    expect(playgroundKey(undefined, a)).toBe("tr_dev_sk_project_a");
    expect(playgroundKey("tr_dev_sk_project_a", a)).toBeUndefined();
    expect(playgroundKey("tr_dev_sk_project_a", null)).toBe("");
    expect(playgroundKey("", null)).toBeUndefined();
    expect(playgroundKey("tr_dev_typed_by_reader", null)).toBeUndefined();
    expect(playgroundKey("tr_dev_typed_by_reader", a)).toBeUndefined();
  });
});

describe("keepKeysOf", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Catches: reader B signing in to a tab where reader A made a key, and using A's dev environment.
  it("keeps keys for the same reader and drops them when another reader signs in", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    vi.stubGlobal("fetch", async () =>
      Response.json({ name: "Docs key", apiKey: "tr_dev_sk_reader_a", scopes: null })
    );
    keepKeysOf("user_a");
    await createDocsKey("proj_shared", null);
    keepKeysOf("user_a");
    expect(pickKey(JSON.parse(store.get("trigger-docs:keys")!), "proj_shared", [])).not.toBeNull();
    keepKeysOf("user_b");
    expect(JSON.parse(store.get("trigger-docs:keys")!)).toEqual([]);
    // Still known as a docs key, so the playground field holding it gets cleared.
    expect(isDocsKey("tr_dev_sk_reader_a")).toBe(true);
  });
});
