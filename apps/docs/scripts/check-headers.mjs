#!/usr/bin/env node
// Security headers at <base>: docs pages can't be framed by other sites, embed pages only by the
// dashboards, and every response carries nosniff and a referrer policy.
// Usage: node scripts/check-headers.mjs <base, e.g. http://localhost:43000/docs>
const [base] = process.argv.slice(2);
if (!base) {
  console.error("usage: node scripts/check-headers.mjs <base>");
  process.exit(2);
}
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const headers = bypass ? { "x-vercel-protection-bypass": bypass } : {};

const cases = [
  ["/introduction", "frame-ancestors 'self'"],
  ["/introduction.md", "frame-ancestors 'self'"],
  ["/embed/introduction", "frame-ancestors 'self' https://cloud.trigger.dev"],
];
const failures = [];
for (const [path, csp] of cases) {
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, { headers, redirect: "manual" });
  const got = {
    csp: res.headers.get("content-security-policy") ?? "",
    nosniff: res.headers.get("x-content-type-options"),
    referrer: res.headers.get("referrer-policy"),
  };
  if (
    res.status !== 200 ||
    !got.csp.startsWith(csp) ||
    got.nosniff !== "nosniff" ||
    got.referrer !== "strict-origin-when-cross-origin"
  )
    failures.push(`${path}: status ${res.status}, ${JSON.stringify(got)}`);
}
for (const f of failures) console.log(`FAIL ${f}`);
console.log(failures.length ? "headers: failed" : `headers: ${cases.length} passed`);
process.exitCode = failures.length ? 1 : 0;
