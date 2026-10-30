import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const site = env.match(/^VITE_CONVEX_SITE_URL=(.+)$/m)?.[1]?.replace(/^"|"$/g, "");
assert(site, "Select a Convex deployment first");
const root = await fetch(site, { signal: AbortSignal.timeout(20_000) });
assert.equal(root.status, 200);
assert(root.headers.get("content-type")?.includes("text/html"));
const html = await root.text();
assert(html.includes("Convex × Trigger.dev"), "Wrong app was served");
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+\.(?:js|css))"/g)].map(
  (match) => match[1]!
);
assert(
  assets.some((asset) => asset.endsWith(".js")) && assets.some((asset) => asset.endsWith(".css")),
  "Missing built assets"
);
for (const asset of assets) {
  const response = await fetch(new URL(asset, site), { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, `Asset not served: ${asset}`);
  assert(
    !response.headers.get("content-type")?.includes("text/html"),
    `Asset returned SPA HTML: ${asset}`
  );
  assert((await response.arrayBuffer()).byteLength > 0);
}
const route = await fetch(new URL("/field-guide", site), { signal: AbortSignal.timeout(20_000) });
assert.equal(route.status, 200);
assert.equal(await route.text(), html, "SPA fallback did not serve the current index");
const missing = await fetch(new URL("/missing-asset.js", site), {
  signal: AbortSignal.timeout(20_000),
});
assert.equal(missing.status, 404);
console.log(
  JSON.stringify(
    { result: "PASS", site, assets, spaFallback: true, missingAsset404: true },
    null,
    2
  )
);
