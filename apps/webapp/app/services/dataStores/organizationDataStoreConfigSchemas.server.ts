import { z } from "zod";

// ---------------------------------------------------------------------------
// ClickHouse config (kind = CLICKHOUSE)
// ---------------------------------------------------------------------------

/** V1: single secret-store key that supplies the ClickHouse connection URL. */
export const ClickhouseDataStoreConfigV1 = z.object({
  version: z.literal(1),
  data: z.object({
    /** Key into the SecretStore that resolves to a ClickhouseConnection ({url}). */
    secretKey: z.string(),
  }),
});

export type ClickhouseDataStoreConfigV1 = z.infer<typeof ClickhouseDataStoreConfigV1>;

/** Discriminated union over version — extend by adding new literals here. */
export const ClickhouseDataStoreConfig = z.discriminatedUnion("version", [
  ClickhouseDataStoreConfigV1,
]);

export type ClickhouseDataStoreConfig = z.infer<typeof ClickhouseDataStoreConfig>;

// ---------------------------------------------------------------------------
// Top-level per-kind union
// ---------------------------------------------------------------------------

/**
 * Secrets are resolved to URLs at registry load time so the factory never
 * needs to touch the secret store on the hot path.
 */
export type ParsedClickhouseDataStore = {
  kind: "CLICKHOUSE";
  url: string;
};

/** Union of all parsed data store types. Extend as new DataStoreKind values are added. */
export type ParsedDataStore = ParsedClickhouseDataStore;
