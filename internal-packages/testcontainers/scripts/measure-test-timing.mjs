#!/usr/bin/env node
// Measure testcontainers boot/teardown vs test time for a single test file.
//
// Usage (from any package dir, or pass --cwd):
//   node <path>/measure-test-timing.mjs <testFile> [--cwd <packageDir>] [--runs N]
//
// Relies on the TESTCONTAINERS_TIMING log gate in src/logs.ts and runs vitest with
// --disableConsoleIntercept so the JSON timing lines reach stdout.

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const testFile = args.find((a) => !a.startsWith("--"));
const cwd = valueOf("--cwd") ?? process.cwd();
const runs = Number(valueOf("--runs") ?? "1");

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (!testFile) {
  console.error("usage: measure-test-timing.mjs <testFile> [--cwd dir] [--runs N]");
  process.exit(1);
}

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      ["exec", "vitest", "run", testFile, "--disableConsoleIntercept"],
      { cwd, env: { ...process.env, TESTCONTAINERS_TIMING: "1" } }
    );

    let out = "";
    const collect = (buf) => (out += buf.toString());
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("close", () => {
      const cleanups = [];
      let duration = null;
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{")) {
          try {
            const ev = JSON.parse(trimmed);
            if (ev.type === "cleanup") cleanups.push(ev);
          } catch {}
        }
        const m = trimmed.match(/Duration\s+([\d.]+)s/);
        if (m) duration = Number(m[1]);
      }
      resolve({ cleanups, duration, passed: /Tests\s+\d+ passed/.test(out) });
    });
  });
}

for (let i = 0; i < runs; i++) {
  const { cleanups, duration, passed } = await runOnce();
  const byResource = {};
  for (const c of cleanups) {
    const key = c.resource.split(":")[0];
    byResource[key] ??= { totalMs: 0, count: 0 };
    byResource[key].totalMs += c.durationMs ?? 0;
    byResource[key].count += 1;
  }
  const teardownMs = Object.values(byResource).reduce((a, r) => a + r.totalMs, 0);
  console.log(`\nrun ${i + 1}/${runs}  passed=${passed}  wall=${duration}s  teardown=${(teardownMs / 1000).toFixed(2)}s`);
  for (const [res, r] of Object.entries(byResource)) {
    console.log(`  teardown ${res}: ${(r.totalMs / 1000).toFixed(2)}s over ${r.count}`);
  }
}
