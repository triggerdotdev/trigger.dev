#!/usr/bin/env node
// `pnpm --filter docs-site check`: the docs checks CI runs on every docs PR.
//   1. heading id tests, internal links and dashboard figure tags (source only, no build needed;
//      stale figures are warnings, see check-figures.mjs)
//   2. against the built site, served here on a free port: the URL contract, the MCP shape and
//      the security headers
// Run `pnpm --filter docs-site build` first; `check --links` runs step 1 only.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";

const app = path.resolve(import.meta.dirname, "..");
const started = Date.now();
const run = (...args) =>
  spawnSync(process.execPath, args, { cwd: app, stdio: "inherit" }).status === 0;

let ok =
  run("node_modules/vitest/vitest.mjs", "run", "lib/slug.test.ts") &
  run("scripts/check-links.mjs") &
  run("scripts/check-figures.mjs");

if (!process.argv.includes("--links")) {
  if (!existsSync(path.join(app, ".next/BUILD_ID"))) {
    console.error("no build: run `pnpm --filter docs-site build` first (or `check --links`)");
    process.exit(1);
  }
  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  // Next's own entry under node (not the .bin shim), so kill() stops the server itself.
  const next = createRequire(path.join(app, "package.json")).resolve("next/dist/bin/next");
  const server = spawn(process.execPath, [next, "start", "--port", String(port)], {
    cwd: app,
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    const base = `http://localhost:${port}/docs`;
    for (let i = 0; ; i++) {
      if (
        (await fetch(`${base}/llms.txt`).then(
          (r) => r.status,
          () => 0
        )) === 200
      )
        break;
      if (i > 120 || server.exitCode !== null) throw new Error("next start did not come up");
      await new Promise((r) => setTimeout(r, 250));
    }
    ok =
      run("scripts/check-urls.mjs", base) &
      run("scripts/check-mcp.mjs", base) &
      run("scripts/check-headers.mjs", base) &
      ok;
  } finally {
    server.kill();
  }
}

console.log(`check: ${ok ? "passed" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(ok ? 0 : 1);
