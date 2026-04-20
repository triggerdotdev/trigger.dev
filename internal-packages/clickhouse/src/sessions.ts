import { ClickHouseSettings } from "@clickhouse/client";
import { z } from "zod";
import { ClickhouseReader, ClickhouseWriter } from "./client/types.js";

export const SessionV1 = z.object({
  environment_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  session_id: z.string(),
  environment_type: z.string(),
  friendly_id: z.string(),
  external_id: z.string().default(""),
  type: z.string(),
  task_identifier: z.string().default(""),
  tags: z.array(z.string()).default([]),
  metadata: z.unknown(),
  closed_at: z.number().int().nullish(),
  closed_reason: z.string().default(""),
  expires_at: z.number().int().nullish(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  _version: z.string(),
  _is_deleted: z.number().int().default(0),
});

export type SessionV1 = z.input<typeof SessionV1>;

// Column order for compact format - must match ClickHouse table schema
export const SESSION_COLUMNS = [
  "environment_id",
  "organization_id",
  "project_id",
  "session_id",
  "environment_type",
  "friendly_id",
  "external_id",
  "type",
  "task_identifier",
  "tags",
  "metadata",
  "closed_at",
  "closed_reason",
  "expires_at",
  "created_at",
  "updated_at",
  "_version",
  "_is_deleted",
] as const;

export type SessionColumnName = (typeof SESSION_COLUMNS)[number];

export const SESSION_INDEX = Object.fromEntries(SESSION_COLUMNS.map((col, idx) => [col, idx])) as {
  readonly [K in SessionColumnName]: number;
};

export type SessionFieldTypes = {
  environment_id: string;
  organization_id: string;
  project_id: string;
  session_id: string;
  environment_type: string;
  friendly_id: string;
  external_id: string;
  type: string;
  task_identifier: string;
  tags: string[];
  metadata: { data: unknown };
  closed_at: number | null;
  closed_reason: string;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  _version: string;
  _is_deleted: number;
};

/**
 * Type-safe tuple representing a Session insert array.
 * Order matches {@link SESSION_COLUMNS} exactly.
 */
export type SessionInsertArray = [
  environment_id: string,
  organization_id: string,
  project_id: string,
  session_id: string,
  environment_type: string,
  friendly_id: string,
  external_id: string,
  type: string,
  task_identifier: string,
  tags: string[],
  metadata: { data: unknown },
  closed_at: number | null,
  closed_reason: string,
  expires_at: number | null,
  created_at: number,
  updated_at: number,
  _version: string,
  _is_deleted: number,
];

export function getSessionField<K extends SessionColumnName>(
  session: SessionInsertArray,
  field: K
): SessionFieldTypes[K] {
  return session[SESSION_INDEX[field]] as SessionFieldTypes[K];
}

export function insertSessionsCompactArrays(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insertCompactRaw({
    name: "insertSessionsCompactArrays",
    table: "trigger_dev.sessions_v1",
    columns: SESSION_COLUMNS,
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      ...settings,
    },
  });
}

export function insertSessions(ch: ClickhouseWriter, settings?: ClickHouseSettings) {
  return ch.insert({
    name: "insertSessions",
    table: "trigger_dev.sessions_v1",
    schema: SessionV1,
    settings: {
      enable_json_type: 1,
      type_json_skip_duplicated_paths: 1,
      ...settings,
    },
  });
}

// ─── read path ───────────────────────────────────────────────────

export const SessionV1QueryResult = z.object({
  session_id: z.string(),
});

export type SessionV1QueryResult = z.infer<typeof SessionV1QueryResult>;

/**
 * Base query builder for listing Sessions. Filters + pagination are composed
 * on top of this; callers can chain `.where(...).orderBy(...).limit(...)`.
 */
export function getSessionsQueryBuilder(ch: ClickhouseReader, settings?: ClickHouseSettings) {
  return ch.queryBuilder({
    name: "getSessions",
    baseQuery: "SELECT session_id FROM trigger_dev.sessions_v1 FINAL",
    schema: SessionV1QueryResult,
    settings,
  });
}

export function getSessionsCountQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getSessionsCount",
    baseQuery: "SELECT count() as count FROM trigger_dev.sessions_v1 FINAL",
    schema: z.object({ count: z.number().int() }),
    settings,
  });
}

export const SessionTagsQueryResult = z.object({
  tag: z.string(),
});

export type SessionTagsQueryResult = z.infer<typeof SessionTagsQueryResult>;

export function getSessionTagsQueryBuilder(
  ch: ClickhouseReader,
  settings?: ClickHouseSettings
) {
  return ch.queryBuilder({
    name: "getSessionTags",
    baseQuery: "SELECT DISTINCT arrayJoin(tags) as tag FROM trigger_dev.sessions_v1",
    schema: SessionTagsQueryResult,
    settings,
  });
}
