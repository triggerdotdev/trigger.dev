import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./tool-api-client";
import { buildApiTools } from "./tool-api";

/**
 * ask_support sends the user's question and a shared secret to a configured endpoint. With only
 * one half of the configuration present it must send nothing at all.
 */

const requested: string[] = [];

function askSupport() {
  const ctx = { userActorToken: "uat", apiOrigin: "https://api.example.com" };
  const tools = buildApiTools({
    ctx,
    client: createApiClient(ctx),
    renderInvestigations: (() => []) as any,
  });
  return (tools.ask_support as any).execute({ question: "why is my run failing?" }, {} as any);
}

describe("ask_support configuration", () => {
  beforeEach(() => {
    requested.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        requested.push(typeof input === "string" ? input : input.url);
        return new Response('data: {"type":"text-delta","delta":"hi"}\n', { status: 200 });
      })
    );
    delete process.env.SUPPORT_ASK_URL;
    delete process.env.SUPPORT_ASK_SECRET;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPPORT_ASK_URL;
    delete process.env.SUPPORT_ASK_SECRET;
  });

  it("sends nothing when the secret is set but the URL is not", async () => {
    process.env.SUPPORT_ASK_SECRET = "shh";

    const result = await askSupport();

    expect(result).toEqual({
      error: "The support assistant isn't configured in this environment.",
    });
    expect(requested).toEqual([]);
  });

  it("sends nothing when the URL is set but the secret is not", async () => {
    process.env.SUPPORT_ASK_URL = "https://support.example.com/api/ask";

    const result = await askSupport();

    expect(result).toEqual({
      error: "The support assistant isn't configured in this environment.",
    });
    expect(requested).toEqual([]);
  });

  it("asks the configured endpoint when both are set", async () => {
    process.env.SUPPORT_ASK_URL = "https://support.example.com/api/ask";
    process.env.SUPPORT_ASK_SECRET = "shh";

    const result = await askSupport();

    expect(result).toEqual({ answer: "hi" });
    expect(requested).toEqual(["https://support.example.com/api/ask"]);
  });
});
