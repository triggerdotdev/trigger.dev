import { writeFileSync } from "node:fs";
import { Prisma } from "@trigger.dev/database";
import { expect } from "vitest";
import { postgresTest } from "./index";
import {
  createAdapterClient,
  createClientPair,
  createRustClient,
  describe,
  runShape,
  type ShapeCase,
  type ShapeResult,
} from "./adapterGolden";

function safeWrite(path: string, contents: string) {
  try {
    writeFileSync(path, contents);
  } catch {
    void 0;
  }
}

const shapes: ShapeCase[] = [
  {
    id: 1,
    name: "text[] param with explicit cast (= ANY(${ids}::text[]))",
    callSite: "PostgresRunStore.ts L2159-2161 (documented binding workaround)",
    upstream: "#24338",
    setup: async (c) => {
      await c.$executeRawUnsafe(`CREATE TABLE g1 (id text)`);
      await c.$executeRawUnsafe(`INSERT INTO g1 (id) VALUES ('a'),('b'),('c')`);
    },
    run: (c) => {
      const ids = ["a", "c"];
      return c.$queryRaw`SELECT id FROM g1 WHERE id = ANY(${ids}::text[]) ORDER BY id`;
    },
  },
  {
    id: 2,
    name: "array results (array_agg + text[] column)",
    callSite: "text[] columns / array_agg readers",
    upstream: "#27823",
    setup: async (c) => {
      await c.$executeRawUnsafe(`CREATE TABLE g2 (id text, tags text[])`);
      await c.$executeRawUnsafe(`INSERT INTO g2 (id, tags) VALUES ('x', ARRAY['a','b'])`);
    },
    run: (c) => c.$queryRaw`SELECT tags, array_agg(id ORDER BY id) AS ids FROM g2 GROUP BY tags`,
  },
  {
    id: 3,
    name: "bigint from COUNT(*)",
    callSite: "PostgresRunStore.ts:2162,2171; DeploymentListPresenter.server.ts:322,168",
    upstream: "#23926",
    setup: async (c) => {
      await c.$executeRawUnsafe(`CREATE TABLE g3 (id int)`);
      await c.$executeRawUnsafe(`INSERT INTO g3 (id) VALUES (1),(2),(3)`);
    },
    run: (c) => c.$queryRaw`SELECT COUNT(*) AS c FROM g3`,
  },
  {
    id: 4,
    name: "bigint ns timestamp (keyset pagination)",
    callSite: "taskEventStore.server.ts L339-386",
    run: (c) => c.$queryRaw`SELECT 1723058400000000000::int8 AS t`,
  },
  {
    id: 5,
    name: "NUMERIC -> Prisma.Decimal",
    callSite: "QueueListPresenter.server.ts:383",
    setup: async (c) => {
      await c.$executeRawUnsafe(`CREATE TABLE g5 (n numeric(30,4))`);
      await c.$executeRawUnsafe(`INSERT INTO g5 (n) VALUES ('12345.6789')`);
    },
    run: (c) => c.$queryRaw`SELECT n FROM g5`,
  },
  {
    id: 6,
    name: "enum cast (CAST('LOG'::text AS enum))",
    callSite: "taskEventStore.server.ts:196,224,274,303,327",
    setup: async (c) => {
      await c.$executeRawUnsafe(`CREATE TYPE g6_kind AS ENUM ('LOG','SPAN')`);
    },
    run: (c) => c.$queryRaw`SELECT CAST('LOG'::text AS g6_kind) AS kind`,
  },
  {
    id: 7,
    name: "jsonb with cast parameters (to_jsonb(${v}::text/::int))",
    callSite: "dashboardPreferences.server.ts:145,175",
    upstream: "#24338",
    run: (c) => {
      const theme = "dark";
      const contrast = 1;
      return c.$queryRaw`
        SELECT jsonb_set(
                 jsonb_set('{}'::jsonb, '{theme}', to_jsonb(${theme}::text)),
                 '{contrast}', to_jsonb(${contrast}::int)
               ) AS prefs`;
    },
  },
  {
    id: 8,
    name: "timestamptz round-trip (Date param)",
    callSite: "Date -> timestamptz writers",
    upstream: "#28629",
    run: (c) => {
      const d = new Date("2026-08-07T12:34:56.789Z");
      return c.$queryRaw`SELECT ${d}::timestamptz AS ts`;
    },
  },
  {
    id: 9,
    name: "IN with varying arity",
    callSite: "boundedIn() (TRI-4480)",
    upstream: "#21803",
    setup: async (c) => {
      await c.$executeRawUnsafe(`CREATE TABLE g9 (id text)`);
      await c.$executeRawUnsafe(`INSERT INTO g9 (id) VALUES ('a'),('b'),('c'),('d')`);
    },
    run: async (c) => {
      const one = await c.$queryRaw`SELECT id FROM g9 WHERE id IN (${"a"}) ORDER BY id`;
      const three =
        await c.$queryRaw`SELECT id FROM g9 WHERE id IN (${"a"},${"c"},${"d"}) ORDER BY id`;
      return { arity1: one, arity3: three };
    },
  },
  {
    id: 11,
    name: "nulls, empty result set, zero-row RETURNING",
    callSite: "classic divergence points",
    setup: async (c) => {
      await c.$executeRawUnsafe(`CREATE TABLE g11 (id text)`);
      await c.$executeRawUnsafe(`INSERT INTO g11 (id) VALUES ('a')`);
    },
    run: async (c) => {
      const nulls = await c.$queryRaw`SELECT NULL::text AS a, NULL::int AS b`;
      const empty = await c.$queryRaw`SELECT id FROM g11 WHERE 1=0`;
      const returning = await c.$queryRaw`UPDATE g11 SET id = id WHERE 1=0 RETURNING id`;
      return { nulls, empty, returning };
    },
  },
];

function renderTable(results: ShapeResult[]): string {
  const rows = results.map((r) => {
    const status = r.identical ? "IDENTICAL" : r.adapterErrored ? "ADAPTER ERROR" : "DIVERGES";
    return [
      `### Shape ${r.id}: ${r.name}`,
      `- call site: ${r.callSite}${r.upstream ? ` (upstream ${r.upstream})` : ""}`,
      `- result: **${status}**`,
      `- rust:    \`${r.rust}\``,
      `- adapter: \`${r.adapter}\``,
      "",
    ].join("\n");
  });
  const pass = results.filter((r) => r.identical).length;
  return [`## Golden matrix: ${pass}/${results.length} identical`, "", ...rows].join("\n");
}

postgresTest(
  "Deliverable B — raw-result equivalence matrix",
  async ({ postgresContainer }) => {
    const pair = await createClientPair(postgresContainer.getConnectionUri());
    const results: ShapeResult[] = [];

    try {
      for (const shape of shapes) {
        const result = await runShape(pair, shape);
        results.push(result);
        const tag = result.identical ? "OK  " : result.adapterErrored ? "ERR " : "DIFF";
        console.log(`[TRI-13039][B] ${tag} shape ${result.id}: ${result.name}`);
        if (!result.identical) {
          console.log(`    rust:    ${result.rust}`);
          console.log(`    adapter: ${result.adapter}`);
        }
      }
    } finally {
      await pair.disconnect();
    }

    const md = renderTable(results);
    console.log("\n" + md);
    safeWrite("/Users/eric/code/triggerdotdev/isolated/adapter-pg-spike-work/golden-matrix.md", md);

    for (const r of results) {
      expect(r.rust, `shape ${r.id} (${r.name}) must be byte-identical`).toBe(r.adapter);
    }
  },
  180000
);

postgresTest(
  "Deliverable B shape 10 — unqualified SQL relying on search_path / {schema} (#28128)",
  async ({ postgresContainer }) => {
    const baseUri = postgresContainer.getConnectionUri();

    const admin = createRustClient(baseUri);
    await admin.$executeRawUnsafe(`CREATE SCHEMA s1`);
    await admin.$executeRawUnsafe(`CREATE TABLE s1.t (id text)`);
    await admin.$executeRawUnsafe(`INSERT INTO s1.t (id) VALUES ('inschema')`);
    await admin.$executeRawUnsafe(`CREATE TABLE public.pt (id text)`);
    await admin.$executeRawUnsafe(`INSERT INTO public.pt (id) VALUES ('inpublic')`);
    await admin.$disconnect();

    const capture = async (fn: () => Promise<unknown>) => {
      try {
        return { ok: true as const, desc: describe(await fn()) };
      } catch (err: any) {
        return {
          ok: false as const,
          desc: `${err?.code}: ${String(err?.message).split("\n").pop()}`,
        };
      }
    };

    const nonPublicAdapter = createAdapterClient(baseUri, "s1");
    const publicAdapter = createAdapterClient(baseUri, "public");
    try {
      const nonPublic = await capture(() =>
        nonPublicAdapter.$queryRaw(Prisma.sql([`SELECT id FROM t ORDER BY id`]))
      );
      const publicSchema = await capture(() =>
        publicAdapter.$queryRaw(Prisma.sql([`SELECT id FROM pt ORDER BY id`]))
      );

      console.log(`[TRI-13039][B] shape 10 adapter {schema:s1} unqualified: ${nonPublic.desc}`);
      console.log(
        `[TRI-13039][B] shape 10 adapter {schema:public} unqualified: ${publicSchema.desc}`
      );
      safeWrite(
        "/Users/eric/code/triggerdotdev/isolated/adapter-pg-spike-work/golden-shape10.md",
        [
          "## Shape 10: unqualified SQL relying on search_path (#28128)",
          "",
          "The adapter's `{schema}` option does NOT set a session search_path for raw SQL.",
          `- {schema:s1} + unqualified \`t\` (non-public): ${nonPublic.ok ? "OK" : "FAILS"} -> \`${nonPublic.desc}\``,
          `- {schema:public} + unqualified \`pt\` (public): ${publicSchema.ok ? "OK" : "FAILS"} -> \`${publicSchema.desc}\``,
          "",
          "Prod impact: both DATABASE_URL and RUN_OPS_DATABASE_URL use ?schema=public, so unqualified",
          "raw SQL resolves fine under the adapter. Only a non-public schema would break.",
        ].join("\n")
      );

      expect(nonPublic.ok, "non-public schema breaks unqualified raw SQL (confirms #28128)").toBe(
        false
      );
      expect(publicSchema.ok, "public schema resolves unqualified raw SQL under the adapter").toBe(
        true
      );
      expect(publicSchema.desc).toBe(`[{id: "inpublic"}]`);
    } finally {
      await Promise.allSettled([nonPublicAdapter.$disconnect(), publicAdapter.$disconnect()]);
    }
  },
  180000
);
