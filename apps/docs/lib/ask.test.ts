import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAskHandler, type AskDeps } from "./ask";
import {
  dailyTokens,
  fixedWindowLimiter,
  limiterFromEnv,
  readerKey,
  type Counter,
} from "./ask-rate-limit";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** A model that searches once, then answers citing [1]. Records each prompt it got. */
function scriptedModel() {
  const prompts: unknown[] = [];
  const steps: LanguageModelV3StreamPart[][] = [
    [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "search_docs",
        input: JSON.stringify({ query: "retry" }),
      },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
    ],
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Tasks retry by default [1]." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ],
  ];
  const model = new MockLanguageModelV3({
    doStream: async (opts) => {
      prompts.push(opts.prompt);
      return { stream: simulateReadableStream({ chunks: steps[prompts.length - 1]! }) };
    },
  });
  return { model, prompts };
}

const deps = (over: Partial<AskDeps> = {}): AskDeps => ({
  model: scriptedModel().model,
  pageIndex: "/errors-retrying: Errors & Retrying",
  search: () => [
    {
      title: "Errors & Retrying",
      url: "https://trigger.dev/docs/errors-retrying",
      sections: [
        {
          id: "retrying",
          heading: "Retrying",
          excerpt: "SECRET-EXCERPT tasks retry up to 3 times",
        },
      ],
    },
  ],
  readPage: async () => undefined,
  log: () => {},
  ...over,
});

const ask = (text: string, ip = "1.2.3.4", headers: Record<string, string> = {}) =>
  new Request("http://localhost/docs/api/ask", {
    method: "POST",
    headers: { "x-forwarded-for": ip, ...headers },
    body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text }] }] }),
  });

/** Like a fetch that never gets headers: rejects only when the signal fires. */
const hang = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

/** Test counter, standing in for Redis. */
function memoryCounter(): Counter {
  const m = new Map<string, number>();
  return { incr: async (k, _ttl, by = 1) => m.set(k, (m.get(k) ?? 0) + by).get(k)! };
}

describe("ask handler", () => {
  it("streams an answer with numbered sources, and the excerpt goes to the model only", async () => {
    const { model, prompts } = scriptedModel();
    const logs: Record<string, unknown>[] = [];
    const res = await createAskHandler(deps({ model, log: (e) => logs.push(e) }))(
      ask("how do retries work")
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Tasks retry by default [1].");
    expect(body).toContain('"url":"https://trigger.dev/docs/errors-retrying#retrying"');
    expect(body).not.toContain("SECRET-EXCERPT");
    expect(JSON.stringify(prompts[1])).toContain("[1] Errors & Retrying › Retrying");
    expect(JSON.stringify(prompts[1])).toContain("SECRET-EXCERPT");
    // System prompt carries the page index and a cache breakpoint.
    expect(JSON.stringify(prompts[0])).toContain("/errors-retrying: Errors & Retrying");
    expect(JSON.stringify(prompts[0])).toContain('"cacheControl"');
    expect(logs.find((l) => l.event === "ask")).toMatchObject({
      questionChars: "how do retries work".length,
      sources: ["https://trigger.dev/docs/errors-retrying#retrying"],
      toolCalls: { search_docs: 1 },
    });
  });

  // Catches: the reader's question (or tool inputs that repeat it) written to server logs.
  it("logs counts and sources, never the question text", async () => {
    const logs: Record<string, unknown>[] = [];
    const res = await createAskHandler(deps({ log: (e) => logs.push(e) }))(
      ask("my secret project question")
    );
    await res.text();
    expect(JSON.stringify(logs)).not.toContain("secret project");
    expect(JSON.stringify(logs)).not.toContain('"retry"');
  });

  // Catches: the daily cap filling up with nothing in the logs until readers hit it.
  it("logs the site count on answers and the limit kind on every 429", async () => {
    const logs: Record<string, unknown>[] = [];
    const limiter = fixedWindowLimiter(
      memoryCounter(),
      { perMinute: 1, perDay: 100, sitePerDay: 100 },
      () => 0
    );
    const handler = createAskHandler(deps({ limiter, log: (e) => logs.push(e) }));
    await (await handler(ask("first"))).text();
    expect((await handler(ask("second"))).status).toBe(429);
    expect(logs.find((l) => l.event === "ask")).toMatchObject({ siteCount: 1 });
    expect(logs).toContainEqual({ event: "ask.limited", limit: "minute" });
  });

  // Catches: every reader behind the proxy sharing one bucket, or anyone spoofing the header.
  it("keys limits on the proxy's client IP only when the shared secret matches", async () => {
    const limiter = fixedWindowLimiter(
      memoryCounter(),
      { perMinute: 1, perDay: 100, sitePerDay: 100 },
      () => 0
    );
    const handler = createAskHandler(deps({ limiter, proxySecret: "s3cret" }));
    const viaProxy = (reader: string, secret = "s3cret") =>
      ask("q", "9.9.9.9", { "x-docs-client-ip": reader, "x-docs-proxy-secret": secret });
    // Two readers through the same proxy address get their own minute.
    expect((await handler(viaProxy("1.1.1.1"))).status).toBe(200);
    expect((await handler(viaProxy("2.2.2.2"))).status).toBe(200);
    // A wrong secret falls back to the connecting address, already used by nobody else.
    expect((await handler(viaProxy("3.3.3.3", "guess"))).status).toBe(200);
    expect((await handler(viaProxy("4.4.4.4", "guess"))).status).toBe(429);
  });

  // Catches: limits that only log, or a 500 instead of a message the panel can show.
  it("returns 429 with a readable message once a reader passes the per-minute limit", async () => {
    const limiter = fixedWindowLimiter(
      memoryCounter(),
      { perMinute: 2, perDay: 100, sitePerDay: 100 },
      () => 0
    );
    const handler = createAskHandler(deps({ limiter }));
    await limiter.check("1.2.3.4");
    await limiter.check("1.2.3.4");
    const res = await handler(ask("again"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.text()).toMatch(/too quickly/);
    // Another reader is unaffected.
    expect(await limiter.check("5.6.7.8")).toMatchObject({ ok: true });
  });

  // Catches: one client over its own limit using up the site-wide budget for everyone.
  it("doesn't count a reader's rejected requests toward the site cap", async () => {
    const limiter = fixedWindowLimiter(
      memoryCounter(),
      { perMinute: 1, perDay: 10, sitePerDay: 2 },
      () => 0
    );
    for (let i = 0; i < 20; i++) await limiter.check("spammer");
    expect(await limiter.check("reader")).toEqual({ ok: true, siteCount: 2, day: 0 });
  });

  it("enforces the site-wide daily cap across readers", async () => {
    const limiter = fixedWindowLimiter(
      memoryCounter(),
      { perMinute: 10, perDay: 10, sitePerDay: 2 },
      () => 0
    );
    await limiter.check("a");
    await limiter.check("b");
    expect(await limiter.check("c")).toMatchObject({
      ok: false,
      limit: "site",
      message: expect.stringMatching(/daily limit/),
    });
  });

  // Catches: one IPv6 client rotating addresses inside its /64 for a fresh bucket each time.
  it("keys IPv6 readers on their /64", async () => {
    expect(readerKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(readerKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(readerKey("2001:db8::7")).toBe("2001:db8:0:0::/64");
    expect(readerKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(readerKey("1.2.3.4")).toBe("1.2.3.4");
    const limiter = fixedWindowLimiter(
      memoryCounter(),
      { perMinute: 1, perDay: 100, sitePerDay: 100 },
      () => 0
    );
    expect(await limiter.check("2001:db8:1:2::1")).toMatchObject({ ok: true });
    expect(await limiter.check("2001:db8:1:2::2")).toMatchObject({ ok: false, limit: "minute" });
    expect(await limiter.check("2001:db8:1:3::1")).toMatchObject({ ok: true });
  });

  // Catches: long answers spending far more than the request cap assumes, with nothing to stop them.
  it("closes Ask for the day once answers have spent the token budget", async () => {
    // A scripted answer uses 10 input and 5 output tokens: 10 + 5 * 5 = 35.
    const limiter = fixedWindowLimiter(
      memoryCounter(),
      { perMinute: 100, perDay: 100, sitePerDay: 100, siteTokensPerDay: 35, reservePerAnswer: 10 },
      () => 0
    );
    const handler = createAskHandler(deps({ limiter }));
    expect((await handler(ask("first", "1.1.1.1"))).status).toBe(200);
    expect(await limiter.check("2.2.2.2")).toMatchObject({ ok: true });
    await (await handler(ask("second", "3.3.3.3"))).text();
    const res = await handler(ask("third", "4.4.4.4"));
    expect(res.status).toBe(429);
    expect(await res.text()).toMatch(/daily limit/);
  });

  // Catches: no deployable way to keep Ask AI off (the production build requires the API key).
  it("treats ASK_AI_DAILY_TOKENS=0 as closed, not as the default budget", async () => {
    expect(dailyTokens("0")).toBe(0);
    expect(dailyTokens(undefined)).toBe(25_000_000);
    expect(dailyTokens("")).toBe(25_000_000);
    expect(dailyTokens("abc")).toBe(25_000_000);
    const limiter = fixedWindowLimiter(memoryCounter(), { siteTokensPerDay: dailyTokens("0") });
    expect(await limiter.check("1.1.1.1")).toMatchObject({ ok: false, limit: "site" });
  });

  // Catches: answers started at the same moment all passing the token check before any has spent.
  it("reserves each answer's cost at admission, and a stopped answer keeps its reservation", async () => {
    const counter = memoryCounter();
    const limiter = fixedWindowLimiter(
      counter,
      { perMinute: 100, perDay: 100, sitePerDay: 100, siteTokensPerDay: 100, reservePerAnswer: 50 },
      () => 0
    );
    const admitted = await Promise.all(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((ip) => limiter.check(ip))
    );
    expect(admitted.map((r) => r.ok)).toEqual([true, true, false]);
    const tokens = () => counter.incr("ask:site:t:0", 86400, 0);
    const before = await tokens();
    // Stopped mid-step with nothing reported: the reservation stays.
    await limiter.spend({ inputTokens: 0, outputTokens: 0 }, true);
    expect(await tokens()).toBe(before);
    // Finished: settles to the tokens used (30 + 4 * 5 = 50, the reservation, so no change)...
    await limiter.spend({ inputTokens: 30, outputTokens: 4 });
    expect(await tokens()).toBe(before);
    // ...and a cheap answer gives the rest back.
    await limiter.spend({ inputTokens: 10, outputTokens: 0 });
    expect(await tokens()).toBe(before - 40);
  });

  // Catches: rejected questions keeping their reservation, which locks Ask AI once answers settle.
  it("gives a rejected question's reservation back", async () => {
    const counter = memoryCounter();
    const limiter = fixedWindowLimiter(
      counter,
      { perMinute: 100, perDay: 100, sitePerDay: 100, siteTokensPerDay: 100, reservePerAnswer: 50 },
      () => 0
    );
    const tokens = () => counter.incr("ask:site:t:0", 86400, 0);
    await limiter.check("1.1.1.1");
    await limiter.check("2.2.2.2");
    expect(await limiter.check("3.3.3.3")).toMatchObject({ ok: false, limit: "site" });
    expect(await tokens()).toBe(100);
    // Both admitted answers come in cheap: the site opens again.
    await limiter.spend({ inputTokens: 10 }, false, 0);
    await limiter.spend({ inputTokens: 10 }, false, 0);
    expect(await tokens()).toBe(20);
    expect(await limiter.check("3.3.3.3")).toMatchObject({ ok: true });
  });

  // Catches: an answer running past midnight settling against the new day's counter.
  it("settles an answer on the day it was admitted", async () => {
    const counter = memoryCounter();
    let clock = 86_400_000 - 1000;
    const limiter = fixedWindowLimiter(
      counter,
      { perMinute: 100, perDay: 100, sitePerDay: 100, siteTokensPerDay: 100, reservePerAnswer: 50 },
      () => clock
    );
    const admitted = await limiter.check("1.1.1.1");
    expect(admitted).toMatchObject({ ok: true, day: 0 });
    clock += 2000;
    await limiter.spend({ inputTokens: 10 }, false, admitted.ok ? admitted.day : undefined);
    expect(await counter.incr("ask:site:t:0", 86400, 0)).toBe(10);
    expect(await counter.incr("ask:site:t:1", 86400, 0)).toBe(0);
  });

  // Catches: the response ending before the budget write, which a frozen function never finishes.
  it("finishes the response only after the answer's spend is written", async () => {
    let settled = false;
    const limiter = {
      check: async () => ({ ok: true as const, siteCount: 1, day: 0 }),
      spend: () => new Promise<void>((r) => setTimeout(() => ((settled = true), r()), 50)),
    };
    await (await createAskHandler(deps({ limiter }))(ask("hi"))).text();
    expect(settled).toBe(true);
  });

  // Catches: another site's page spending its visitors' Ask allowances with a no-cors POST.
  it("refuses cross-site browser requests before counting them", async () => {
    let checked = 0;
    const limiter = {
      check: async () => (checked++, { ok: true as const, siteCount: 1, day: 0 }),
      spend: async () => {},
    };
    const handler = createAskHandler(deps({ limiter }));
    const res = await handler(ask("hi", "1.1.1.1", { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(checked).toBe(0);
    expect((await handler(ask("hi", "1.1.1.1", { "sec-fetch-site": "same-origin" }))).status).toBe(
      200
    );
  });

  it("fails closed with 503 when the limiter is down", async () => {
    const limiter = {
      check: async () => Promise.reject(new Error("ECONNREFUSED")),
      spend: async () => {},
    };
    const res = await createAskHandler(deps({ limiter }))(ask("hi"));
    expect(res.status).toBe(503);
  });

  // Catches: a deploy without REDIS_URL running Ask with no spend cap.
  it("answers 503 on a deployed site without Redis, and runs unlimited only locally", async () => {
    expect(limiterFromEnv(undefined, false)).toBeUndefined();
    const logs: Record<string, unknown>[] = [];
    const limiter = limiterFromEnv(undefined, true);
    const res = await createAskHandler(deps({ limiter, log: (e) => logs.push(e) }))(ask("hi"));
    expect(res.status).toBe(503);
    expect(logs).toContainEqual({ event: "ask.ratelimit_error", error: "REDIS_URL is not set" });
  });

  // Catches: a hung model leaving the reader with a spinner, an empty "answer" and no log line.
  it("ends a hung answer at the time limit with an error the panel shows, and logs it", async () => {
    const logs: Record<string, unknown>[] = [];
    const hung = new MockLanguageModelV3({
      doStream: ({ abortSignal }) => hang(abortSignal),
    });
    const res = await createAskHandler(
      deps({ model: hung, timeoutMs: 50, log: (e) => logs.push(e) })
    )(ask("hi"));
    const body = await res.text();
    expect(body).toContain('"type":"error"');
    expect(body).toContain("took too long");
    expect(logs).toContainEqual(expect.objectContaining({ event: "ask.timeout", steps: 0 }));
  });

  // Catches: a reader's Stop leaving the model call running, with its spend in no log.
  it("stops the model call when the reader goes away, and logs it", async () => {
    const logs: Record<string, unknown>[] = [];
    let modelSignal: AbortSignal | undefined;
    const model = new MockLanguageModelV3({
      doStream: ({ abortSignal }) => {
        modelSignal = abortSignal;
        return hang(abortSignal);
      },
    });
    const reader = new AbortController();
    const req = new Request(ask("hi"), { signal: reader.signal });
    const res = await createAskHandler(deps({ model, log: (e) => logs.push(e) }))(req);
    const done = res.text();
    reader.abort();
    await done;
    expect(modelSignal?.aborted).toBe(true);
    expect(logs).toContainEqual(expect.objectContaining({ event: "ask.aborted" }));
    expect(logs.find((l) => l.event === "ask.timeout")).toBeUndefined();
  });

  // Catches: a failing read_page vanishing from the logs while the model works around it.
  it("logs a tool that throws", async () => {
    const logs: Record<string, unknown>[] = [];
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: (call++ === 0
            ? [
                { type: "stream-start", warnings: [] },
                {
                  type: "tool-call",
                  toolCallId: "c1",
                  toolName: "read_page",
                  input: JSON.stringify({ path: "/x" }),
                },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "Sorry." },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
              ]) as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const res = await createAskHandler(
      deps({
        model,
        readPage: () => Promise.reject(new Error("ENOENT /var/task/x.mdx")),
        log: (e) => logs.push(e),
      })
    )(ask("hi"));
    expect(await res.text()).toContain('"type":"tool-output-error"');
    expect(logs).toContainEqual({
      event: "ask.tool_error",
      tool: "read_page",
      error: "ENOENT /var/task/x.mdx",
    });
  });

  // Catches: a burst of clicks answered "too quickly" also using up the reader's whole day.
  it("doesn't count requests refused for the minute toward the day", async () => {
    let t = 0;
    const limiter = fixedWindowLimiter(
      memoryCounter(),
      { perMinute: 6, perDay: 60, sitePerDay: 1000 },
      () => t
    );
    for (let i = 0; i < 70; i++) await limiter.check("clicker");
    t = 60_000;
    expect(await limiter.check("clicker")).toMatchObject({ ok: true });
  });

  it("rejects bad bodies and overlong questions with 400", async () => {
    const handler = createAskHandler(deps());
    expect((await handler(new Request("http://x", { method: "POST", body: "nope" }))).status).toBe(
      400
    );
    const long = await handler(ask("x".repeat(2001)));
    expect(long.status).toBe(400);
    expect(await long.text()).toMatch(/2000 characters/);
  });
});
