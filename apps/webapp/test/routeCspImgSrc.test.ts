// `withImgSrc` lets a route's own img-src win, so the document policy only protects
// the other AI surfaces while no route sets a broader one. This scans literal policy
// strings in the webapp sources — it cannot see one assembled at runtime.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEBAPP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_ROOTS = ["app", "server.ts"];
const SKIP_DIRS = new Set(["node_modules", "build", "dist", "coverage", ".turbo", ".cache"]);
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const CSP_HEADER_OWNER = "app/entry.server.tsx";

/** Sources that resolve inside the document itself, so they carry nothing outward. */
const LOCAL_SOURCES = new Set([
  "'self'",
  "'none'",
  "data:",
  "blob:",
  "filesystem:",
  "mediastream:",
]);

/**
 * Hosts that serve content any stranger can upload. Necessarily incomplete — the
 * shape checks below are what actually holds the line.
 */
const PUBLIC_UPLOAD_HOSTS = [
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
  "gist.githubusercontent.com",
  "objects.githubusercontent.com",
  "camo.githubusercontent.com",
  "imgur.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "s3.amazonaws.com",
  "storage.googleapis.com",
  "lh3.googleusercontent.com",
  "blob.core.windows.net",
  "pages.dev",
  "vercel.app",
  "netlify.app",
  "ngrok.io",
  "ngrok-free.app",
  "trycloudflare.com",
];

const IMAGE_DIRECTIVES = new Set(["img-src", "default-src"]);
const HAS_IMAGE_DIRECTIVE = /(^|;)\s*(img-src|default-src)\s+\S/i;
const STRING_LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

function hostOf(source: string): string | undefined {
  const withoutScheme = source.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = withoutScheme.split("/")[0]?.split(":")[0];
  return host && host.includes(".") ? host.toLowerCase() : undefined;
}

/** Why this source would let an image request carry data off-origin, if it would. */
function overBroadReason(source: string): string | undefined {
  if (LOCAL_SOURCES.has(source.toLowerCase())) return undefined;
  if (source === "*" || source.includes("*")) {
    return "wildcard matches hosts nobody vetted";
  }
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) {
    return "a bare scheme allows every host on it";
  }
  const host = hostOf(source);
  if (!host) return undefined;
  const match = PUBLIC_UPLOAD_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
  return match ? `${match} accepts uploads from anyone` : undefined;
}

/** Every over-broad image source in a policy string, as `directive source: reason`. */
function overBroadImageSources(policy: string): string[] {
  const findings: string[] = [];

  for (const segment of policy.split(";")) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const [directive, ...sources] = tokens;
    if (!directive || !IMAGE_DIRECTIVES.has(directive.toLowerCase())) continue;

    for (const source of sources) {
      const reason = overBroadReason(source);
      if (reason) findings.push(`${directive} ${source}: ${reason}`);
    }
  }

  return findings;
}

function collectSourceFiles(): string[] {
  const files: string[] = [];

  const walk = (absolute: string) => {
    const stats = statSync(absolute);
    if (stats.isFile()) {
      if (SOURCE_FILE.test(absolute) && !TEST_FILE.test(absolute)) files.push(absolute);
      return;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      walk(join(absolute, entry.name));
    }
  };

  for (const root of SCAN_ROOTS) walk(join(WEBAPP_ROOT, root));
  return files;
}

const sourceFiles = collectSourceFiles().map((absolute) => ({
  path: relative(WEBAPP_ROOT, absolute).replaceAll("\\", "/"),
  contents: readFileSync(absolute, "utf8"),
}));

function stringLiteralsIn(contents: string): string[] {
  return [...contents.matchAll(STRING_LITERAL)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

describe("route-level image CSP", () => {
  it("scans the webapp sources", () => {
    expect(sourceFiles.length).toBeGreaterThan(500);
    expect(sourceFiles.map((f) => f.path)).toContain(CSP_HEADER_OWNER);
    expect(sourceFiles.map((f) => f.path)).toContain("server.ts");
  });

  it("recognises the over-broad shapes", () => {
    expect(overBroadImageSources("img-src *")).toHaveLength(1);
    expect(overBroadImageSources("img-src 'self' https:")).toHaveLength(1);
    expect(overBroadImageSources("img-src https://*.example.com")).toHaveLength(1);
    expect(overBroadImageSources("default-src * ; img-src 'self'")).toHaveLength(1);
    expect(overBroadImageSources("img-src https://raw.githubusercontent.com")).toHaveLength(1);
    expect(
      overBroadImageSources("frame-ancestors *; img-src 'self' data: blob: https://a.example.com")
    ).toEqual([]);
  });

  it("finds no over-broad image policy in any source", () => {
    const findings: string[] = [];

    for (const file of sourceFiles) {
      for (const literal of stringLiteralsIn(file.contents)) {
        if (!HAS_IMAGE_DIRECTIVE.test(literal)) continue;
        for (const finding of overBroadImageSources(literal)) {
          findings.push(`${file.path}: ${finding}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it("sets the Content-Security-Policy header in one place only", () => {
    const setters = sourceFiles
      .filter((file) => /["']Content-Security-Policy["']/i.test(file.contents))
      .map((file) => file.path);

    expect(setters).toEqual([CSP_HEADER_OWNER]);
  });
});
