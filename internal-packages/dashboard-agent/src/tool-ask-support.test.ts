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

    expect(result).toEqual({ answer: "«untrusted:supportAnswer» hi «/untrusted:supportAnswer»" });
    expect(requested).toEqual(["https://support.example.com/api/ask"]);
  });

  it("fences the answer and drops links outside the allowlist", async () => {
    process.env.SUPPORT_ASK_URL = "https://support.example.com/api/ask";
    process.env.SUPPORT_ASK_SECRET = "shh";
    const delta =
      "See [evil](https://evil.example/x) and https://evil.example/y, or [docs](https://trigger.dev/docs/x).";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`data: ${JSON.stringify({ type: "text-delta", delta })}\n`, { status: 200 })
      )
    );

    const { answer } = await askSupport();

    // Catches: dropping the fence, or leaving an off-allowlist link in the answer.
    expect(answer).toMatch(/^«untrusted:supportAnswer» .* «\/untrusted:supportAnswer»$/);
    expect(answer).not.toContain("evil.example");
    expect(answer).toContain("[docs](https://trigger.dev/docs/x)");
  });

  it.each([
    ["an open paren before an @", "see https://trigger.dev(@evil.com/x"],
    ["an escaped paren in an inline link", "see [x](https://trigger.dev\\)@evil.com)"],
    ["a protocol-relative reference definition", "see [1]\n\n[1]: //evil.com"],
    ["a single-slash reference definition", "see [1]\n\n[1]: https:/evil.com"],
    ["an autolink", "see <https://evil.com/x>"],
    ["a bare www host", "see www.evil.com/x"],
    [
      "a nested label with an entity-encoded scheme",
      "[Click [here]](https&#58;&#47;&#47;evil.com/path)",
    ],
    ["a nested label with a hex-encoded colon", "[Click [here]](https&#x3a;//evil.com/path)"],
    [
      "entity-encoded dot segments",
      "[x](https://github.com/triggerdotdev/&#x2e;&#x2e;/&#x2e;&#x2e;/evil.com)",
    ],
  ])("removes a link hidden behind %s", async (_name, delta) => {
    process.env.SUPPORT_ASK_URL = "https://support.example.com/api/ask";
    process.env.SUPPORT_ASK_SECRET = "shh";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`data: ${JSON.stringify({ type: "text-delta", delta })}\n`, { status: 200 })
      )
    );

    const { answer } = await askSupport();

    // Catches: prefix-matching the allowlist instead of parsing the destination's host.
    expect(answer).not.toContain("evil.com");
  });

  it.each([
    ["a blockquote", "> [r]: &#104;ttps://evil.com\n\n[click][r]"],
    ["a list item", "- [r]: &#104;ttps://evil.com\n\n[click][r]"],
    ["a label split across lines", "[a\nb]: &#104;ttps://evil.com\n\n[click][a b]"],
  ])("escapes a character reference in a reference definition inside %s", async (_name, delta) => {
    process.env.SUPPORT_ASK_URL = "https://support.example.com/api/ask";
    process.env.SUPPORT_ASK_SECRET = "shh";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`data: ${JSON.stringify({ type: "text-delta", delta })}\n`, { status: 200 })
      )
    );

    const { answer } = await askSupport();

    // Catches: a character reference left to decode into a link destination.
    expect(answer).toContain("&amp;#104;ttps://evil.com");
  });
});
