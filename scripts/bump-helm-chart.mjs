import { readFileSync, writeFileSync } from "node:fs";

const VERSION_SOURCE = "packages/cli-v3/package.json";
const CHART_PATH = "hosting/k8s/helm/Chart.yaml";

const { version } = JSON.parse(readFileSync(VERSION_SOURCE, "utf8"));
const desiredVersion = `version: ${version}`;
const desiredAppVersion = `appVersion: v${version}`;

const original = readFileSync(CHART_PATH, "utf8");

const versionMatch = original.match(/^version:.*$/m);
const appVersionMatch = original.match(/^appVersion:.*$/m);

if (!versionMatch || !appVersionMatch) {
  const missing = [!versionMatch && "version:", !appVersionMatch && "appVersion:"]
    .filter(Boolean)
    .join(", ");
  console.error(`${CHART_PATH} is missing required key(s): ${missing}`);
  process.exit(1);
}

if (versionMatch[0] === desiredVersion && appVersionMatch[0] === desiredAppVersion) {
  console.log(`${CHART_PATH} already at ${version} (from ${VERSION_SOURCE}), no changes`);
} else {
  const updated = original
    .replace(/^version:.*/m, desiredVersion)
    .replace(/^appVersion:.*/m, desiredAppVersion);
  writeFileSync(CHART_PATH, updated);
  console.log(`${CHART_PATH} bumped to ${version} (from ${VERSION_SOURCE})`);
}
