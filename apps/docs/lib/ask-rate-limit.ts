import { createHash } from "node:crypto";
import { isIPv6 } from "node:net";
import Redis from "ioredis";

type LimitKind = "minute" | "day" | "site";
type RateLimit =
  | { ok: true; siteCount: number; day: number }
  | { ok: false; limit: LimitKind; retryAfterSeconds: number; message: string };
export type RateLimiter = {
  check(ip: string): Promise<RateLimit>;
  /** Settles an admitted answer's reservation with the tokens it used, on the day it was reserved
   * (`check`'s `day`; today when omitted). A stopped answer (`aborted`) never gives back its
   * reservation: its unfinished step used tokens that no usage reports. */
  spend(usage: TokenUsage, aborted?: boolean, day?: number): Promise<void>;
};
export type TokenUsage = { inputTokens?: number; outputTokens?: number };

/**
 * Output tokens cost this many input tokens (Sonnet-class prices: $2 in, $10 out per million).
 * The daily budget counts input tokens plus output tokens times this.
 */
const OUTPUT_WEIGHT = 5;

/**
 * Fixed windows: per reader per minute and per day, and caps on the whole site per day: answers,
 * and tokens. 25M weighted tokens is about $50 a day at Sonnet-class prices; set
 * ASK_AI_DAILY_TOKENS to change it (for another model, or a different spend).
 */
const LIMITS = {
  perMinute: 6,
  perDay: 60,
  sitePerDay: 1000,
  siteTokensPerDay: dailyTokens(process.env.ASK_AI_DAILY_TOKENS),
  // Reserved from the budget when an answer starts (a typical answer's weighted tokens), so answers
  // running at once can't all start against the same remaining budget.
  reservePerAnswer: 25_000,
};

/** `ASK_AI_DAILY_TOKENS=0` closes Ask AI until it changes: the off switch a production build allows. */
export function dailyTokens(value: string | undefined): number {
  return value && /^\d+$/.test(value.trim()) ? Number(value) : 25_000_000;
}

/** The counters a limiter keeps, so the Redis and test limiters share one rule. */
export type Counter = { incr(key: string, ttlSeconds: number, by?: number): Promise<number> };

/** IPv6 clients usually hold a whole /64, so a reader is their /64, not one address. */
export function readerKey(ip: string): string {
  if (!isIPv6(ip) || /^::ffff:\d/i.test(ip)) return ip.replace(/^::ffff:/i, "");
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

const siteClosed = (retryAfterSeconds: number): RateLimit => ({
  ok: false,
  limit: "site",
  retryAfterSeconds,
  message: "Ask AI has reached its daily limit. Search still works, and Ask AI is back tomorrow.",
});

export function fixedWindowLimiter(
  counter: Counter,
  overrides: Partial<typeof LIMITS> = {},
  now = () => Date.now()
): RateLimiter {
  const limits = { ...LIMITS, ...overrides };
  const today = () => Math.floor(now() / 86_400_000);
  return {
    async spend({ inputTokens = 0, outputTokens = 0 }, aborted = false, day = today()) {
      const weighted = Math.round(inputTokens + outputTokens * OUTPUT_WEIGHT);
      const owed = weighted - limits.reservePerAnswer;
      const settle = aborted ? Math.max(0, owed) : owed;
      if (settle !== 0) await counter.incr(`ask:site:t:${day}`, 86400, settle);
    },
    async check(ip) {
      // Keys hold a hash of the IP, never the IP, and expire with their window.
      const who = createHash("sha256").update(readerKey(ip)).digest("hex").slice(0, 32);
      const t = Math.floor(now() / 1000);
      const minute = Math.floor(t / 60);
      const day = Math.floor(t / 86400);
      // The minute is checked before the day is counted, so a burst doesn't use up the reader's day.
      const m = await counter.incr(`ask:${who}:m:${minute}`, 60);
      if (m > limits.perMinute)
        return {
          ok: false,
          limit: "minute",
          retryAfterSeconds: 60 - (t % 60),
          message: "You're asking questions too quickly. Wait a minute and try again.",
        };
      const d = await counter.incr(`ask:${who}:d:${day}`, 86400);
      const untilTomorrow = 86400 - (t % 86400);
      if (d > limits.perDay)
        return {
          ok: false,
          limit: "day",
          retryAfterSeconds: untilTomorrow,
          message:
            "You've reached today's limit for Ask AI. Search still works, and the limit resets tomorrow.",
        };
      // Tokens spent or reserved today, before this answer's reservation.
      const tokensKey = `ask:site:t:${day}`;
      const tokens = await counter.incr(tokensKey, 86400, limits.reservePerAnswer);
      // A rejected question gives its reservation straight back, so rejections never hold budget.
      // shortcut: not atomic, so a question racing a rejection can see its reservation for a moment;
      // a Lua script would close that if near-cap rejections ever matter.
      const reject = async () => {
        await counter.incr(tokensKey, 86400, -limits.reservePerAnswer);
        return siteClosed(untilTomorrow);
      };
      if (tokens - limits.reservePerAnswer >= limits.siteTokensPerDay) return reject();
      // Counted only for readers within their own limits, so one client can't use up the site's budget.
      const site = await counter.incr(`ask:site:d:${day}`, 86400);
      if (site > limits.sitePerDay) return reject();
      return { ok: true, siteCount: site, day };
    },
  };
}

function redisCounter(url: string): Counter {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
  });
  // Without a listener ioredis logs every reconnect failure; one line a minute is enough.
  let lastErrorLog = 0;
  redis.on("error", (e: Error) => {
    if (Date.now() - lastErrorLog < 60_000) return;
    lastErrorLog = Date.now();
    console.log(JSON.stringify({ event: "ask.redis_error", error: e.message }));
  });
  return {
    async incr(key, ttl, by = 1) {
      const res = await redis.multi().incrby(key, by).expire(key, ttl, "NX").exec();
      const [err, value] = res?.[0] ?? [new Error("Redis transaction aborted")];
      if (err) throw err;
      return value as number;
    },
  };
}

const missingRedis: RateLimiter = {
  check: () => Promise.reject(new Error("REDIS_URL is not set")),
  spend: async () => {},
};

/**
 * Redis-backed limits when a Redis URL is set. Without one, local dev runs unlimited, but a
 * deployed site gets a limiter that always fails, so Ask answers 503 instead of running uncapped.
 */
export function limiterFromEnv(
  url = process.env.REDIS_URL,
  deployed = !!process.env.VERCEL_ENV
): RateLimiter | undefined {
  if (url) return fixedWindowLimiter(redisCounter(url));
  return deployed ? missingRedis : undefined;
}
