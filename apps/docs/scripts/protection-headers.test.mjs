import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { protectionHeaders } from "./protection-headers.mjs";

// Catches: the OIDC switch falling back to the bypass secret, so a passing check proves nothing
// about Trusted Sources; a long check reusing an expired token; and concurrent workers each
// requesting their own token.
let server;
let issued = 0;
const jwt = (exp) =>
  ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".");

beforeAll(async () => {
  server = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer fixture-request-token");
      issued++;
      // The first token is about to expire, the second is good for 10 minutes.
      const exp = Math.floor(Date.now() / 1000) + (issued === 1 ? 30 : 600);
      res.end(JSON.stringify({ value: jwt(exp) }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
});
afterAll(() => server?.close());

it("uses the bypass secret unless the OIDC switch is on", async () => {
  expect(await protectionHeaders({ VERCEL_AUTOMATION_BYPASS_SECRET: "b" })).toEqual({
    "x-vercel-protection-bypass": "b",
  });
  expect(await protectionHeaders({})).toEqual({});
});

// Before any token is cached: the cache lasts the process, as in a real check.
it("fails loudly outside a job with id-token: write", async () => {
  await expect(protectionHeaders({ DOCS_TRUSTED_OIDC: "1" })).rejects.toThrow(/id-token: write/);
});

it("sends the GitHub OIDC token, not the bypass secret, and refetches one about to expire", async () => {
  const env = {
    DOCS_TRUSTED_OIDC: "1",
    VERCEL_AUTOMATION_BYPASS_SECRET: "b",
    ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${server.address().port}/token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
  };
  const first = await protectionHeaders(env);
  expect(Object.keys(first)).toEqual(["x-vercel-trusted-oidc-idp-token"]);
  // 16 concurrent workers all see the expiring token: one refresh, which they all share.
  const rest = await Promise.all(Array.from({ length: 16 }, () => protectionHeaders(env)));
  expect(new Set(rest.map((h) => JSON.stringify(h))).size).toBe(1);
  expect(rest[0]).not.toEqual(first);
  expect(issued).toBe(2);
});
