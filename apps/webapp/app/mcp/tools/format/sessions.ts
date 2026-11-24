import { isRunFriendlyId } from "~/components/dashboard-agent/run-id";
import { capText, untrusted } from "./logFields";

const ID_CHARS = 256;
const TEXT_CHARS = 200;
const JSON_CHARS = 4_000;
const MESSAGE_CHARS = 4_000;
const TRANSCRIPT_CHARS = 40_000;
const LISTED_CHANNELS = 100;
const LISTED_TASKS = 50;

const SESSION_ID = /^session_[A-Za-z0-9]{1,64}$/;
const PLAIN_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const CHANNEL_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const RUN_REASON = /^[a-z][a-z_-]{0,31}$/;
const RUN_STATUS = /^[A-Z_]{1,32}$/;
const ROLES = new Set(["user", "assistant", "system"]);

export type SessionStatus = "ACTIVE" | "CLOSED" | "EXPIRED";

export const renderSessionId = (id: string) =>
  SESSION_ID.test(id) ? id : untrusted(id, "session-id", ID_CHARS);

const renderRunId = (id: string) =>
  id.length <= 128 && isRunFriendlyId(id) ? id : untrusted(id, "session-run-id", ID_CHARS);

const renderRunStatus = (status: string) =>
  RUN_STATUS.test(status) ? status : untrusted(status, "session-run-status", ID_CHARS);

const renderToken = (value: string, source: string) =>
  PLAIN_TOKEN.test(value) ? `"${value}"` : untrusted(value, source, ID_CHARS);

const TRIGGER_SETTINGS = [
  "machine",
  "queue",
  "concurrency",
  "concurrencyKey",
  "tags",
  "maxAttempts",
  "maxDuration",
  "lockToVersion",
  "externalDeploymentId",
  "region",
  "idleTimeoutInSeconds",
  "ttl",
];
const SHAPE_DEPTH = 4;
const SHAPE_NODES = 120;
const KEY_CHARS = 64;
const SETTING_CHARS = 200;
const SETTING_JSON_CHARS = 250;
const CLIPPED_PREFIX_CHARS = 100;
const OMITTED = "…";

type Budget = { nodes: number; hiddenKeys: number; renamed: { keys: number } };

/** A formatted phone number (10+ characters of digits, spaces, dashes); ISO dates are not. */
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const looksLikePhone = (key: string) => !ISO_DATE.test(key) && /^\+?\d[\d\s-]{8,}\d$/.test(key);

const WHOLE_KEY_SECRETS = [/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/, /:\/\/[^\s/@:]+:[^\s/@]+@/];
const TOKEN_SECRETS = [
  /^tr_(?:dev|stg|prod|preview|pat|oat|uat|ecc)_(?:sk_)?[A-Za-z0-9]{16,}$/,
  /^(?:tr_[a-z]+_|sk[-_]|pk[-_]|rk[-_])(?=.*\d)[A-Za-z0-9_-]{8,}$/,
  /^(?:ghp_|gho_|glpat-|github_pat_|xox[a-z]-)[A-Za-z0-9_-]{8,}$/,
  /^(?:AKIA|ASIA)[A-Z0-9]{16}$/,
  /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-fA-F]{32,}$/,
  /^\+?\d{10,}$/,
];
const KEY_SEPARATORS = /[\s:=/?&#,;|]+/;

const isDigit = (char: string) => char >= "0" && char <= "9";

/** Random strings start a "word" (lower to upper, letter to digit) far more often than names do. */
function looksRandom(token: string) {
  if (token.length < 32 || !/^[A-Za-z0-9+/=_-]+$/.test(token) || !/\d/.test(token)) return false;
  const chars = token.replace(/[_-]/g, "");
  let starts = 0;
  for (let i = 1; i < chars.length; i++) {
    const before = chars[i - 1]!;
    const after = chars[i]!;
    const lowerToUpper = before >= "a" && before <= "z" && after >= "A" && after <= "Z";
    if (lowerToUpper || isDigit(before) !== isDigit(after)) starts++;
  }
  return starts / chars.length >= 0.28;
}

/** A key of at most KEY_CHARS that is itself data: an email, a token, a phone number, a random string. */
function looksLikeSecret(key: string) {
  if (looksLikePhone(key) || WHOLE_KEY_SECRETS.some((pattern) => pattern.test(key))) return true;
  return key
    .split(KEY_SEPARATORS)
    .some((token) => TOKEN_SECRETS.some((pattern) => pattern.test(token)) || looksRandom(token));
}

/** Real keys starting with "[" get one more, so they can never equal a hidden-key marker. */
function renderKey(key: string, budget: Budget) {
  if (key.length > KEY_CHARS || looksLikeSecret(key)) {
    budget.renamed.keys++;
    return `[hidden key ${++budget.hiddenKeys}]`;
  }
  if (!key.startsWith("[")) return key;
  budget.renamed.keys++;
  return `[${key}`;
}

/** Keeps every setting within the text cap, whatever JSON escaping does to its length. */
function boundSetting(value: unknown) {
  const json = JSON.stringify(value) ?? "";
  return json.length <= SETTING_JSON_CHARS
    ? value
    : `${json.slice(0, CLIPPED_PREFIX_CHARS)}… (clipped, ${json.length} characters)`;
}

/** Key names and value types; with `keepValues`, scalars keep their (capped) value. */
function walk(value: unknown, depth: number, budget: Budget, keepValues: boolean): unknown {
  budget.nodes--;
  if (value === null) return keepValues ? null : "null";
  if (typeof value === "string") return keepValues ? capText(value, SETTING_CHARS) : "string";
  if (typeof value === "number" || typeof value === "boolean") {
    return keepValues ? value : typeof value;
  }
  if (typeof value !== "object") return typeof value;
  if (Array.isArray(value) && !keepValues) return `array(${value.length})`;
  if (depth >= SHAPE_DEPTH) return Array.isArray(value) ? `array(${value.length})` : "object";

  const entries: Array<[string, unknown]> = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (budget.nodes <= 0) {
      entries.push([OMITTED, "more keys omitted"]);
      break;
    }
    entries.push([
      renderKey(key, budget),
      walk((value as Record<string, unknown>)[key], depth + 1, budget, keepValues),
    ]);
  }
  return Array.isArray(value) ? entries.map(([, v]) => v) : Object.fromEntries(entries);
}

const renderShape = (value: unknown, source: string, renamed: { keys: number }) =>
  value == null
    ? "none"
    : untrusted(
        JSON.stringify(walk(value, 0, { nodes: SHAPE_NODES, hiddenKeys: 0, renamed }, false)),
        source,
        JSON_CHARS
      );

/** Settings print their value, before the payload, which prints as key names and types only. */
function renderTriggerConfig(config: unknown, renamed: { keys: number }) {
  if (config == null) return "none";
  if (typeof config !== "object" || Array.isArray(config)) {
    return renderShape(config, "session-trigger-config", renamed);
  }
  const record = config as Record<string, unknown>;
  const budget = { nodes: SHAPE_NODES, hiddenKeys: 0, renamed };
  const settingEntries: Array<[string, unknown]> = TRIGGER_SETTINGS.filter((key) =>
    Object.hasOwn(record, key)
  ).map((key) => [key, boundSetting(walk(record[key], 1, budget, true))]);
  const entries: Array<[string, unknown]> = [];
  const settings = new Set(TRIGGER_SETTINGS);
  for (const key in record) {
    if (!Object.hasOwn(record, key) || settings.has(key)) continue;
    if (budget.nodes <= 0) {
      entries.push([OMITTED, "more keys omitted"]);
      break;
    }
    entries.push([renderKey(key, budget), walk(record[key], 1, budget, false)]);
  }
  const settingsText = untrusted(
    JSON.stringify(Object.fromEntries(settingEntries)),
    "session-trigger-settings",
    JSON_CHARS
  );
  const shapeText = untrusted(
    JSON.stringify(Object.fromEntries(entries)),
    "session-trigger-config",
    JSON_CHARS
  );
  return `settings ${settingsText}, other keys ${shapeText}`;
}

const renderTags = (tags: string[]) =>
  tags.length === 0
    ? "none"
    : untrusted(
        JSON.stringify(tags.map((tag) => capText(tag, TEXT_CHARS))),
        "session-tags",
        JSON_CHARS
      );

const optional = (
  label: string,
  value: string | undefined | null,
  render: (v: string) => string
) => (value ? [`${label}: ${render(value)}`] : []);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function sessionStatus(
  session: { closedAt?: string; expiresAt?: string },
  now: number
): SessionStatus {
  if (session.closedAt) return "CLOSED";
  if (session.expiresAt && new Date(session.expiresAt).getTime() < now) return "EXPIRED";
  return "ACTIVE";
}

type SessionSummary = {
  friendlyId: string;
  externalId: string | null;
  type: string;
  taskIdentifier: string;
  isTest: boolean;
  tags: string[];
  status: SessionStatus;
  closedAt?: string;
  closedReason?: string;
  expiresAt?: string;
  createdAt: string;
};

function summaryLines(session: SessionSummary) {
  return [
    `Status: ${session.status}${session.isTest ? " (test session)" : ""}`,
    `Agent: ${untrusted(session.taskIdentifier, "session-task", ID_CHARS)}`,
    `Type: ${untrusted(session.type, "session-type", ID_CHARS)}`,
    ...optional("External id", session.externalId, (v) =>
      untrusted(v, "session-external-id", ID_CHARS)
    ),
    `Tags: ${renderTags(session.tags)}`,
    `Created: ${session.createdAt}`,
    ...optional("Closed", session.closedAt, (v) => v),
    ...optional("Close reason", session.closedReason, (v) =>
      untrusted(v, "session-close-reason", TEXT_CHARS)
    ),
    ...optional("Expires", session.expiresAt, (v) => v),
  ];
}

export function formatSessionList(list: {
  sessions: Array<SessionSummary & { currentRunFriendlyId?: string }>;
  pagination: { next?: string; previous?: string };
  possibleTasks: Array<{ slug: string }>;
}) {
  const blocks = list.sessions.map((session) =>
    [
      `- ${renderSessionId(session.friendlyId)}`,
      ...[
        ...summaryLines(session),
        ...optional("Current run", session.currentRunFriendlyId, renderRunId),
      ].map((line) => `  ${line}`),
    ].join("\n")
  );

  const tasks = list.possibleTasks.slice(0, LISTED_TASKS).map((task) => task.slug);
  const pages = [
    ...(list.pagination.next
      ? [
          `Older sessions: call again with cursor ${renderToken(list.pagination.next, "session-cursor")} and direction "forward".`,
        ]
      : []),
    ...(list.pagination.previous
      ? [
          `Newer sessions: call again with cursor ${renderToken(list.pagination.previous, "session-cursor")} and direction "backward".`,
        ]
      : []),
  ];

  return [
    `${plural(list.sessions.length, "session")}, newest first.`,
    ...blocks,
    ...pages,
    ...(tasks.length > 0
      ? [
          `Agents you can filter by (taskIdentifiers): ${untrusted(JSON.stringify(tasks), "session-agents", JSON_CHARS)}`,
        ]
      : []),
  ].join("\n");
}

export type SessionDetails = SessionSummary & {
  metadata: unknown;
  triggerConfig: unknown;
  updatedAt: string;
  currentRun: { friendlyId: string; status: string } | null;
  runs: Array<{
    runFriendlyId: string;
    reason: string;
    triggeredAt: string;
    run: { status: string } | null;
  }>;
};

export function formatSessionDetails(session: SessionDetails, channels: string[] | undefined) {
  const renamed = { keys: 0 };
  const runs = session.runs.map((entry) =>
    [
      `- ${renderRunId(entry.runFriendlyId)}`,
      RUN_REASON.test(entry.reason)
        ? entry.reason
        : untrusted(entry.reason, "session-run-reason", TEXT_CHARS),
      `triggered ${entry.triggeredAt}`,
      entry.run ? renderRunStatus(entry.run.status) : "status unknown",
    ].join(" · ")
  );

  const sorted = channels ? [...channels].sort() : [];
  const shown = sorted.slice(0, LISTED_CHANNELS);
  const channelLine =
    channels === undefined
      ? "Channels: could not be listed. Try again."
      : shown.length === 0
        ? "Channels: none"
        : `Channels: ${shown
            .map((name) =>
              CHANNEL_NAME.test(name) ? `"${name}"` : untrusted(name, "session-channel", ID_CHARS)
            )
            .join(
              ", "
            )}${sorted.length > shown.length ? ` (first ${LISTED_CHANNELS} of ${sorted.length})` : ""}`;

  return [
    `Session ${renderSessionId(session.friendlyId)}`,
    ...summaryLines(session),
    `Updated: ${session.updatedAt}`,
    `Current run: ${
      session.currentRun
        ? `${renderRunId(session.currentRun.friendlyId)} (${renderRunStatus(session.currentRun.status)})`
        : "none"
    }`,
    `Metadata: ${renderShape(session.metadata, "session-metadata", renamed)}`,
    `Trigger config: ${renderTriggerConfig(session.triggerConfig, renamed)}`,
    "Metadata and trigger config payload values are omitted; only their keys and types are shown.",
    ...(renamed.keys > 0
      ? [
          "Key names that look like secrets are shown as [hidden key N], and a key name starting with [ is shown with one more [.",
        ]
      : []),
    channelLine,
    runs.length > 0 ? `Runs, newest first (up to 50):\n${runs.join("\n")}` : "Runs: none",
  ].join("\n");
}

type TranscriptMessage = { id: string; message: { role?: unknown; parts?: unknown } };

export function formatTranscriptPage(
  sessionLabel: string,
  messages: TranscriptMessage[],
  nextCursor: string | undefined,
  omitted?: { index: number; bytes: number; id?: string }
) {
  const kept: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const { id, message } = messages[i]!;
    const body = Array.isArray(message.parts) ? JSON.stringify(message.parts) : "";
    const role =
      typeof message.role === "string" && ROLES.has(message.role)
        ? message.role
        : untrusted(String(message.role), "session-message-role", TEXT_CHARS);
    const content = body ? untrusted(body, "session-message", MESSAGE_CHARS) : "(no content)";
    const line = `${role} ${renderToken(id, "session-message-id")}\n${content}`;
    const block =
      body.length > MESSAGE_CHARS
        ? `${line}\nMessage cut at ${MESSAGE_CHARS.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")} characters.`
        : line;
    const cost = block.length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && used + cost > TRANSCRIPT_CHARS) break;
    kept.push(block);
    used += cost;
  }
  kept.reverse();

  const cut = kept.length < messages.length;
  const cursor = cut ? messages[messages.length - kept.length]!.id : nextCursor;

  const notes = [
    ...(omitted
      ? [
          `Skipped message ${(omitted.index + 1).toLocaleString("en-US")}${omitted.id ? ` ${renderToken(omitted.id, "session-message-id")}` : ""} (counting from the oldest): it is ${omitted.bytes.toLocaleString("en-US")} bytes, too large to read here.`,
        ]
      : []),
    ...(cut
      ? [`Stopped at ${TRANSCRIPT_CHARS.toLocaleString("en-US")} characters of messages.`]
      : []),
    ...(cursor === undefined
      ? []
      : cursor.length <= 256
        ? [
            `Earlier messages available. Read again with before ${renderToken(cursor, "session-cursor")} to continue.`,
          ]
        : ["Earlier messages exist, but their cursor is too long to page with this tool."]),
  ];

  return [
    `Session ${sessionLabel} saved transcript: ${plural(kept.length, "message")}, oldest first.`,
    ...kept,
    ...notes,
  ].join("\n");
}

export function formatPlaygroundConversations(
  agentSlug: string,
  conversations: Array<{
    chatId: string;
    title: string;
    runFriendlyId: string | null;
    runStatus: string | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>,
  limit: number
) {
  const agent = untrusted(agentSlug, "playground-agent", ID_CHARS);
  if (conversations.length === 0) {
    return `You have no playground conversations with agent ${agent}.`;
  }
  const lines = conversations.map((conversation) =>
    [
      `- ${untrusted(conversation.title, "playground-title", TEXT_CHARS)}`,
      `  Chat id: ${renderToken(conversation.chatId, "playground-chat-id")}`,
      `  Run: ${
        conversation.runFriendlyId
          ? `${renderRunId(conversation.runFriendlyId)} (${
              conversation.runStatus ? renderRunStatus(conversation.runStatus) : "status unknown"
            }, ${conversation.isActive ? "active" : "finished"})`
          : "none"
      }`,
      `  Created: ${conversation.createdAt.toISOString()}`,
      `  Updated: ${conversation.updatedAt.toISOString()}`,
    ].join("\n")
  );
  return [
    `Showing ${plural(conversations.length, "playground conversation")} of yours with agent ${agent}, most recently updated first. The chat id is the session's externalId.`,
    ...(conversations.length >= limit
      ? [`Stopped at the limit of ${limit}; older conversations may exist.`]
      : []),
    ...lines,
  ].join("\n");
}
