import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { transformerTwoslash } from "fumadocs-twoslash";
import { createFileSystemTypesCache } from "fumadocs-twoslash/cache-fs";

// Type hovers on TypeScript samples that import the SDK. Runs on production builds only
// (DOCS_TWOSLASH=1 turns it on in dev, =0 turns it off), and only when the SDK's types
// are built; otherwise every block renders as plain highlighted code.
const IMPORTS_SDK = /\bfrom\s+["']@trigger\.dev\//;
const SKIP_META = /\bno-?twoslash\b/;
// Popups carry a short summary, not the full JSDoc: every hover ships its own copy in the page.
// Bump TRIM when changing what's kept, so cached results are recomputed.
const TRIM = "trim2";
const KEEP_TAGS = new Set(["deprecated", "default", "defaultValue"]);
const firstParagraph = (docs: string) => {
  const text = docs.split(/\n\s*\n/)[0]!.trim();
  return text.length > 320 ? `${text.slice(0, 317).trimEnd()}...` : text;
};

// next build and next start both run from apps/docs; this file may be bundled elsewhere.
const appDir = process.cwd();

function packageDir(name: string, from = appDir): string | undefined {
  try {
    return path.dirname(
      createRequire(path.join(from, "package.json")).resolve(`${name}/package.json`)
    );
  } catch {
    return undefined;
  }
}

function hashDeclarations(root: string, dir: string, hash: ReturnType<typeof createHash>) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) hashDeclarations(root, file, hash);
    else if (entry.name.endsWith(".d.ts"))
      hash.update(path.relative(root, file)).update(readFileSync(file));
  }
}

// Cache results per SDK types version, so a changed type never serves a stale hover.
function typesKey(): string | undefined {
  const sdk = packageDir("@trigger.dev/sdk");
  // core is the SDK's dependency, not the app's.
  const dirs = [
    sdk,
    packageDir("@trigger.dev/react-hooks"),
    packageDir("@trigger.dev/build"),
    sdk && packageDir("@trigger.dev/core", sdk),
  ];
  const hash = createHash("sha256");
  for (const dir of dirs) {
    const dist = dir && path.join(dir, "dist/esm");
    if (!dist || !existsSync(dist)) return undefined;
    hashDeclarations(dist, dist, hash);
  }
  return `${hash.digest("hex").slice(0, 12)}-${TRIM}`;
}

function enabled(): boolean {
  const flag = process.env.DOCS_TWOSLASH;
  if (flag === "0") return false;
  return flag === "1" || process.env.NODE_ENV === "production";
}

// Value exports of the SDK packages, read from their built CommonJS entry points.
function exportNames(pkg: string): string[] {
  try {
    const mod = createRequire(path.join(appDir, "package.json"))(pkg) as object;
    return Object.keys(mod).filter((n) => /^[A-Za-z]\w*$/.test(n));
  } catch {
    return [];
  }
}

let sdkExports: { pkg: string; names: Set<string> }[] | undefined;
const sdkPackages = () =>
  (sdkExports ??= [
    { pkg: "@trigger.dev/sdk", names: new Set(exportNames("@trigger.dev/sdk")) },
    { pkg: "@trigger.dev/sdk/ai", names: new Set(exportNames("@trigger.dev/sdk/ai")) },
    { pkg: "@trigger.dev/sdk/chat", names: new Set(exportNames("@trigger.dev/sdk/chat")) },
    { pkg: "@trigger.dev/react-hooks", names: new Set(exportNames("@trigger.dev/react-hooks")) },
  ]);

const IDENT = /(?<![\w$.])([A-Za-z_$][\w$]*)(?=\s*[(.<])/g;

/**
 * For a sample that uses SDK names (`task(`, `logger.info`, `useRealtimeRun(`) without importing
 * them, the import line a reader would write. Undefined when it imports the SDK or uses none.
 */
export function inferredImport(code: string, packages = sdkPackages()): string | undefined {
  if (IMPORTS_SDK.test(code)) return;
  const declared = new Set<string>();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g))
    declared.add(m[1]!);
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const part of m[1]!.split(","))
      declared.add(
        part
          .trim()
          .split(/\s+as\s+/)
          .pop()!
          .trim()
      );
  for (const m of code.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/g))
    declared.add(m[1]!);
  const used = new Set([...code.matchAll(IDENT)].map((m) => m[1]!).filter((n) => !declared.has(n)));
  const lines: string[] = [];
  const taken = new Set<string>();
  for (const { pkg, names } of packages) {
    const picked = [...used].filter((n) => names.has(n) && !taken.has(n)).sort();
    picked.forEach((n) => taken.add(n));
    if (picked.length) lines.push(`import { ${picked.join(", ")} } from "${pkg}";`);
  }
  return lines.length ? lines.join("\n") : undefined;
}

const CUT = "// ---cut---";

export function twoslashTransformers(): ReturnType<typeof transformerTwoslash>[] {
  if (!enabled()) return [];
  const key = typesKey();
  if (!key) {
    const message =
      "SDK types aren't built, so code samples get no type hovers. Run `pnpm build:sdk` first.";
    // CI and deploy builds must not ship without hovers by accident.
    if (process.env.CI) throw new Error(`[docs] ${message}`);
    console.warn(`[docs] ${message}`);
    return [];
  }
  const cwd = appDir;
  const cache = createFileSystemTypesCache({ cwd, dir: `.next/cache/twoslash/${key}` });
  return [
    transformerTwoslash({
      filter: (lang, code, options) =>
        (lang === "ts" || lang === "tsx") &&
        !SKIP_META.test(options.meta?.__raw ?? "") &&
        (IMPORTS_SDK.test(code) || !!inferredImport(code)),
      // A sample without its import gets a hidden one above a cut line, so its SDK names resolve.
      // If that still fails, the block renders as the original code (throws: false below).
      typesCache: {
        ...cache,
        preprocess(code) {
          const imports = inferredImport(code);
          return imports ? `${imports}\n${CUT}\n${code}` : code;
        },
      },
      twoslashOptions: {
        cwd,
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          types: ["node"],
        },
        // Samples are excerpts: readers never see compiler errors.
        handbookOptions: { noErrors: true },
        // Keeps hovers on imported bindings (task, logger, ...) and documented members (SDK
        // options), drops undocumented locals, and trims JSDoc before results are cached.
        filterNode: (node) => {
          if (node.type !== "hover") return true;
          const text = node.text.trim();
          if (text === "any" || text.endsWith(": any")) return false;
          if (!text.startsWith("(alias)") && !node.docs) return false;
          if (node.docs) node.docs = firstParagraph(node.docs);
          if (node.tags) node.tags = node.tags.filter(([name]) => KEEP_TAGS.has(name));
          return true;
        },
      },
      // Any failure renders the block as plain highlighted code.
      throws: false,
      onTwoslashError: () => {},
      onShikiError: () => {},
    }),
  ];
}
