import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";

// Catches: the URL check following a redirect to another host with the deployment's bypass secret.
let site, other;
const offsiteHeaders = [];
const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const origin = (server) => `http://127.0.0.1:${server.address().port}`;

beforeAll(async () => {
  other = await listen((req, res) => {
    offsiteHeaders.push(req.headers);
    res.end("ok");
  });
  site = await listen((req, res) => {
    if (req.url === "/docs/introduction") {
      res.writeHead(307, { location: `${origin(other)}/docs/introduction` });
    } else if (req.url === "/docs/v3/feature-matrix") {
      res.writeHead(307, { location: "https://feedback.trigger.dev/roadmap" });
    } else {
      res.writeHead(200);
    }
    res.end();
  });
});
afterAll(() => {
  site?.close();
  other?.close();
});

it("never sends the bypass secret off the base, and passes external redirects docs.json names", async () => {
  const { code, stdout } = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [new URL("./check-urls.mjs", import.meta.url).pathname, `${origin(site)}/docs`],
      { env: { ...process.env, VERCEL_AUTOMATION_BYPASS_SECRET: "fixture-bypass" } },
      (error, stdout) => resolve({ code: error?.code ?? 0, stdout })
    )
  );
  expect(offsiteHeaders).toEqual([]);
  expect(code).toBe(1);
  expect(stdout).toMatch(/FAIL \w+ \/introduction -> offsite/);
  expect(stdout).not.toMatch(/feature-matrix/);
}, 60_000);
