import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAPI } from "fumadocs-openapi/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiProxyOptions } from "./api-proxy";

describe("playground proxy", () => {
  let server: Server;
  let upstream: string;
  let seen: IncomingHttpHeaders = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen = req.headers;
      res.setHeader("set-cookie", "api_set=1");
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const proxy = () => createOpenAPI({ input: {} }).createProxy(apiProxyOptions([upstream]));

  // Catches: the reader's cookies, the edge's proxy secret and client-IP header reaching the API,
  // and the API's Set-Cookie landing on the docs origin.
  it("forwards only the API's headers and drops Set-Cookie", async () => {
    const res = await proxy().GET(
      new Request(
        `http://docs.test/api/proxy?url=${encodeURIComponent(`${upstream}/api/v1/runs`)}&cookie=injected%3D1`,
        {
          headers: {
            authorization: "Bearer tr_dev_xyz",
            accept: "application/json",
            "x-trigger-branch": "main",
            cookie: "docs_signed_in=1; __session=abc",
            "x-docs-proxy-secret": "testsecret",
            "x-docs-client-ip": "1.2.3.4",
          },
        }
      )
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen.authorization).toBe("Bearer tr_dev_xyz");
    expect(seen["x-trigger-branch"]).toBe("main");
    expect(seen.cookie).toBeUndefined();
    expect(seen["x-docs-proxy-secret"]).toBeUndefined();
    expect(seen["x-docs-client-ip"]).toBeUndefined();
  });

  it("keeps the body of a POST", async () => {
    const res = await proxy().POST(
      new Request(`http://docs.test/api/proxy?url=${encodeURIComponent(`${upstream}/api/v1/x`)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      })
    );
    expect(res.status).toBe(200);
    expect(seen["content-type"]).toBe("application/json");
    expect(seen["content-length"]).toBe("7");
  });

  it("refuses origins outside the list", async () => {
    const res = await proxy().GET(
      new Request(`http://docs.test/api/proxy?url=${encodeURIComponent("http://169.254.169.254/")}`)
    );
    expect(res.status).toBe(400);
  });
});
