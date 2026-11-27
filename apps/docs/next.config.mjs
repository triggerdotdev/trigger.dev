import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// Compiled MDX lives under trigger.dev/docs, which can't see this app's node_modules (pnpm is strict),
// so point its imports at the app's copies. Paths are relative to this app.
const rel = (p) => "./" + path.relative(import.meta.dirname, p);
const resolveAlias = {
  "docs-mdx-components": "./components/mdx.tsx",
  "fumadocs-core/server": rel(fileURLToPath(import.meta.resolve("fumadocs-core/server"))),
};

// Doc page URLs: everything but routes, agent files, embed pages and `.md` URLs.
const pagePaths =
  "/:path((?!api/|og/|embed/|hovers/|mcp$|llms|_next/|\\.well-known/|skill\\.md$|robots\\.txt$|sitemap\\.xml$|v3-openapi)(?!.*\\.md$).+)";
// Agent-facing files every page advertises in its Link header.
const discoveryLinks = [
  `</docs/llms.txt>; rel="llms-txt"`,
  `</docs/llms-full.txt>; rel="llms-full-txt"`,
  `</docs/.well-known/api-catalog>; rel="api-catalog"`,
  `</docs/.well-known/mcp/server-card.json>; rel="mcp-server-card"`,
  `</docs/.well-known/agent-card.json>; rel="agent-card"`,
  `</docs/.well-known/agent-skills/index.json>; rel="agent-skills"`,
];

// Build parallelism is capped so `next build` fits an 8 GB machine however many cores it reports:
// Turbopack starts one loader process per core (each holds MDX, Shiki and Twoslash), and Next one
// page-generation worker per core. DOCS_BUILD_CPUS raises it on bigger machines. `next dev`
// compiles every page on the first request, so it gets 8 loaders (no Twoslash there).
const dev = process.env.NODE_ENV === "development";
const buildCpus = Number(process.env.DOCS_BUILD_CPUS) || (dev ? 8 : 4);
process.env.TURBO_TASKS_AVAILABLE_PARALLELISM ??= String(buildCpus);

// Who may frame the embed pages (/docs/embed/*, the dashboard's docs panel): the dashboards, plus
// the dashboard this build points at.
const frameAncestors = [
  "'self'",
  "https://cloud.trigger.dev",
  "https://test-cloud.trigger.dev",
  process.env.NEXT_PUBLIC_DASHBOARD_URL,
]
  .filter(Boolean)
  .join(" ");

/** @type {import('next').NextConfig} */
const config = {
  // Same value as lib/base-path.ts, which this .mjs config file can't import.
  basePath: "/docs",
  reactStrictMode: true,
  // `next dev` served on another host (e.g. next to a local dashboard for the signed-in docs).
  allowedDevOrigins: process.env.DOCS_DEV_ORIGINS?.split(",") ?? [],
  experimental: { cpus: buildCpus },
  // Content lives outside the app (trigger.dev/docs); let the bundler read the monorepo.
  turbopack: { root: path.resolve(import.meta.dirname, "../.."), resolveAlias },
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  // Read here, not at load: `next start` loads this file too, and the deployed app has no docs/.
  async redirects() {
    const docsJson = JSON.parse(
      readFileSync(new URL("../../docs/docs.json", import.meta.url), "utf8")
    );
    const redirects = docsJson.redirects ?? [];
    return [
      // Live Mintlify sends /docs to the introduction.
      { source: "/", destination: "/introduction", permanent: true },
      // Agents keep old `.md` links: /old.md goes to /new.md, as on the previous site. Each twin
      // follows its rule, so an exact rule still wins over a later wildcard (`/v3/:slug*`) that
      // would otherwise take its `.md` path. Wildcard rules already cover their `.md` paths.
      ...redirects.flatMap((r) => [
        { source: r.source, destination: r.destination, permanent: true },
        ...(r.destination.startsWith("/") && !r.source.includes(":")
          ? [{ source: `${r.source}.md`, destination: `${r.destination}.md`, permanent: true }]
          : []),
      ]),
      // The dashboard's docs panel links old paths too; the query (project, theme) carries over.
      ...redirects
        .filter((r) => r.destination.startsWith("/"))
        .map((r) => ({
          source: `/embed${r.source}`,
          destination: `/embed${r.destination}`,
          permanent: true,
        })),
    ];
  },
  async headers() {
    const agentHeaders = [
      // Every page: only the docs frame themselves (the /embed entry below overrides this for the
      // dashboards), no MIME sniffing, and only the origin in cross-site referrers.
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: pagePaths,
        headers: [
          {
            key: "Link",
            value: [
              ...discoveryLinks,
              `</docs/:path.md>; rel="alternate"; type="text/markdown"`,
            ].join(", "),
          },
          { key: "Vary", value: "Accept" },
        ],
      },
      {
        source: "/embed/:path*",
        headers: [
          { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors}` },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
    ];
    // Preview deployments stay out of search engines; production is indexed.
    if (process.env.VERCEL_ENV !== "preview") return agentHeaders;
    return [
      ...agentHeaders,
      { source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
    ];
  },
  async rewrites() {
    return {
      // Agents that send `Accept: text/markdown` get the page's markdown at its normal URL.
      beforeFiles: [
        {
          source: pagePaths,
          has: [{ type: "header", key: "accept", value: ".*text/markdown.*" }],
          destination: "/llms.mdx/:path",
        },
        // `?pm=` / `?framework=` on agent markdown: per-request routes that keep only the reader's
        // variant of each tab group. Without them the static files answer.
        ...["pm", "framework"].flatMap((key) => {
          const has = [{ type: "query", key }];
          return [
            { source: "/:path*.md", has, destination: "/llms-variant/md/:path*" },
            { source: "/llms-full.txt", has, destination: "/llms-variant/full" },
            { source: "/llms-full/:section", has, destination: "/llms-variant/section/:section" },
          ];
        }),
      ],
      afterFiles: [
        // The skill's discovery URL serves /skill.md (before the catch-all below claims it).
        { source: "/.well-known/agent-skills/trigger/skill.md", destination: "/skill.md" },
        { source: "/:path*.md", destination: "/llms.mdx/:path*" },
      ],
    };
  },
};

export default withMDX(config);
