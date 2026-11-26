import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_SOURCE = fileURLToPath(new URL("../../app/env.server.ts", import.meta.url));

export function pointAllRedisAt(host: string, port: number) {
  const keys = new Set(
    [...readFileSync(ENV_SOURCE, "utf8").matchAll(/^\s+([A-Z0-9_]*REDIS[A-Z0-9_]*)\s*:/gm)].map(
      (match) => match[1]!
    )
  );
  for (const key of ["REDIS_HOST", "REDIS_PORT", "REDIS_TLS_DISABLED", ...keys]) {
    if (key.endsWith("_HOST")) process.env[key] = host;
    else if (key.endsWith("_PORT")) process.env[key] = String(port);
    else if (key.endsWith("TLS_DISABLED")) process.env[key] = "true";
    else if (key.endsWith("_PASSWORD") || key.endsWith("_USERNAME")) process.env[key] = "";
    else if (key.endsWith("_URL")) delete process.env[key];
    else if (key.endsWith("_CLUSTER_MODE_ENABLED")) process.env[key] = "0";
  }
}
