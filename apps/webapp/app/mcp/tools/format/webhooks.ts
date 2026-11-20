import { parseFilter, type WebhookEngine } from "@internal/webhook-engine";
import type {
  FilterAst,
  FilterOp,
  WebhookDeliveryListItem,
  WebhookDeliveryObject,
  WebhookDeliveryTargetObject,
} from "@trigger.dev/core/v3";
import type { WebhookDetail } from "~/presenters/v3/WebhookDetailPresenter.server";
import type { WebhookEndpointsListItem } from "~/presenters/v3/WebhookEndpointsListPresenter.server";
import { fenceUntrusted } from "../../gate/fence.server";
import { capText } from "./logFields";

const EVENT_CHARS = 4_000;
const PATH_CHARS = 500;
const RULE_CHARS = 1_000;
const NAME_CHARS = 200;
const LIST_ITEMS = 50;

const ENDPOINT_ID = /^wh_[a-z0-9]{1,64}$/;
const WAITPOINT_ID = /^waitpoint_[a-z0-9]{1,64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2000}$/;

const PREVIEW_UNSAFE =
  /[\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function quoteForPreview(text: string): string {
  return JSON.stringify(text).replace(
    PREVIEW_UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function fenced(text: string, source: string, max = NAME_CHARS): string {
  return fenceUntrusted(capText(text, max), source);
}

function plainId(id: string, pattern: RegExp, source: string): string {
  return pattern.test(id) ? id : fenced(id, source);
}

function fencedList(values: string[], source: string): string {
  const shown = values.slice(0, LIST_ITEMS).map((value) => capText(value, NAME_CHARS));
  const more = values.length - shown.length;
  return `${fenceUntrusted(shown.join(", "), source)}${more > 0 ? ` and ${more} more` : ""}`;
}

const HIDDEN_VALUE = "(value hidden)";
const UNREADABLE_CONDITION = "(condition hidden: it could not be read)";

const OP_TEXT: Record<FilterOp, string> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  in: "in",
  nin: "not in",
  startsWith: "startsWith",
  endsWith: "endsWith",
  contains: "contains",
};

function showsValue(path: string): boolean {
  return /^(event|webhook)(\.|$)/.test(path);
}

function linkFields(node: FilterAst, links: Array<[string, string]>): void {
  switch (node.kind) {
    case "and":
    case "or":
      for (const clause of node.clauses) linkFields(clause, links);
      return;
    case "clause":
      if (node.valueRef !== undefined) links.push([node.path, node.valueRef]);
      return;
    case "quantifier":
      return;
    default:
      throw new Error("unknown filter node");
  }
}

function headerLinkedPaths(ast: FilterAst | undefined): Set<string> {
  const links: Array<[string, string]> = [];
  if (ast) linkFields(ast, links);
  const hidden = new Set<string>();
  const queue = links.flat().filter((path) => !showsValue(path));
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (hidden.has(path)) continue;
    hidden.add(path);
    for (const [a, b] of links) {
      if (a === path) queue.push(b);
      if (b === path) queue.push(a);
    }
  }
  return hidden;
}

function hidesValue(path: string, linked: Set<string>): boolean {
  return !showsValue(path) || linked.has(path);
}

function hidesQuantifier(path: string, linked: Set<string>): boolean {
  if (!showsValue(path)) return true;
  for (const hidden of linked) {
    if (hidden === path || hidden.startsWith(`${path}.`)) return true;
  }
  return false;
}

function conditionValue(value: unknown, hidden: boolean): string {
  return hidden ? HIDDEN_VALUE : JSON.stringify(value);
}

function renderFilter(node: FilterAst, nested: boolean, linked: Set<string>): string {
  switch (node.kind) {
    case "and":
    case "or": {
      const text = node.clauses
        .map((clause) => renderFilter(clause, true, linked))
        .join(node.kind === "and" ? " && " : " || ");
      return nested ? `(${text})` : text;
    }
    case "quantifier":
      return `${node.path} ${node.mode} (${node.clause.path} ${OP_TEXT[node.clause.op]} ${conditionValue(node.clause.value, hidesQuantifier(node.path, linked))})`;
    case "clause":
      return `${node.path} ${OP_TEXT[node.op]} ${node.valueRef ?? conditionValue(node.value, hidesValue(node.path, linked))}`;
    default:
      throw new Error("unknown filter node");
  }
}

function parsedFilter(filter: string): FilterAst | undefined {
  try {
    return parseFilter(filter);
  } catch {
    return undefined;
  }
}

function renderParsed(ast: FilterAst | undefined, linked: Set<string>): string {
  if (!ast) return UNREADABLE_CONDITION;
  try {
    return renderFilter(ast, false, linked);
  } catch {
    return UNREADABLE_CONDITION;
  }
}

function linkedPaths(ast: FilterAst | undefined): Set<string> | undefined {
  try {
    return headerLinkedPaths(ast);
  } catch {
    return undefined;
  }
}

function describeFilter(filter: string): string {
  const ast = parsedFilter(filter);
  const linked = linkedPaths(ast);
  return linked ? renderParsed(ast, linked) : UNREADABLE_CONDITION;
}

export function describeConditions(waiter: { match?: Record<string, unknown>; filter?: string }): {
  match?: string;
  filter?: string;
} {
  const ast = waiter.filter === undefined ? undefined : parsedFilter(waiter.filter);
  const linked = waiter.filter !== undefined && !ast ? undefined : linkedPaths(ast);
  return {
    ...(waiter.match
      ? {
          match: Object.entries(waiter.match)
            .map(
              ([path, value]) =>
                `${path} = ${conditionValue(value, !linked || hidesValue(path, linked))}`
            )
            .join(", "),
        }
      : {}),
    ...(waiter.filter !== undefined
      ? { filter: linked ? renderParsed(ast, linked) : UNREADABLE_CONDITION }
      : {}),
  };
}

export function formatEndpointSearch(
  endpoints: Array<WebhookEndpointsListItem & { ingestUrl: string }>,
  nextCursor: string | undefined,
  filterOptions: { subscribers: string[]; sources: string[] },
  filtered = true
): string {
  const lines = ["## Webhook endpoints\n"];
  if (endpoints.length === 0) {
    lines.push(
      filtered
        ? "No endpoints match."
        : 'This environment has no active endpoints. Set `statuses` to ["active", "inactive", "disabled"] to include inactive and disabled ones.'
    );
  }
  for (const e of endpoints) {
    const tenant = e.tenantId ? ` · tenant ${fenced(e.tenantId, "webhook-endpoint")}` : "";
    const ref = e.externalRef ? ` · external ref ${fenced(e.externalRef, "webhook-endpoint")}` : "";
    lines.push(
      `- ${plainId(e.friendlyId, ENDPOINT_ID, "webhook-endpoint")} · ${e.status.toLowerCase()} · secret ${e.hasSigningSecret ? "set" : "not set"}`
    );
    lines.push(
      `  Declared id: ${fenced(e.declaredId, "webhook-endpoint")} · source ${fenced(e.source, "webhook-source")}${tenant}${ref}`
    );
    lines.push(`  URL: ${fenced(e.ingestUrl, "webhook-endpoint")}`);
  }
  if (nextCursor && CURSOR.test(nextCursor)) {
    lines.push(`\nMore endpoints: call again with cursor "${nextCursor}".`);
  } else if (nextCursor) {
    lines.push(
      "\nMore endpoints exist, but their cursor is too long to return. Narrow the search with filters to see them."
    );
  }
  if (filterOptions.subscribers.length > 0) {
    lines.push(
      `\nSubscribers to filter by: ${fencedList(filterOptions.subscribers, "webhook-subscriber")}`
    );
  }
  if (filterOptions.sources.length > 0) {
    lines.push(`Sources to filter by: ${fencedList(filterOptions.sources, "webhook-source")}`);
  }
  return lines.join("\n");
}

export function formatTaskWebhook(webhook: WebhookDetail): string {
  const lines = [`## Webhook task ${fenced(webhook.slug, "webhook-task")}\n`];
  lines.push(`File: ${fenced(webhook.filePath, "webhook-task", PATH_CHARS)}`);
  lines.push(`Created: ${webhook.createdAt.toISOString()}`);

  lines.push(`\n### Endpoints it subscribes to (${webhook.endpoints.length})`);
  if (webhook.endpoints.length === 0) lines.push("None.");
  for (const e of webhook.endpoints.slice(0, LIST_ITEMS)) {
    const tenant = e.tenantId ? ` · tenant ${fenced(e.tenantId, "webhook-endpoint")}` : "";
    lines.push(
      `- ${plainId(e.friendlyId, ENDPOINT_ID, "webhook-endpoint")} · ${e.status.toLowerCase()} · secret ${e.hasSigningSecret ? "set" : "not set"}`
    );
    lines.push(
      `  Declared id: ${fenced(e.declaredId, "webhook-endpoint")} · source ${fenced(e.source, "webhook-source")}${tenant}`
    );
    lines.push(
      `  Filter: ${e.filter ? fenced(describeFilter(e.filter), "webhook-subscriber-filter", RULE_CHARS) : "none, receives every event"}`
    );
  }
  const more = webhook.endpoints.length - LIST_ITEMS;
  if (more > 0) {
    lines.push(
      `\n${more} more endpoints not shown. Use search_webhook_endpoints with this task in subscribers and statuses ["active", "inactive", "disabled"] to page through them.`
    );
  }
  return lines.join("\n");
}

export type WebhookWaiterList = Awaited<ReturnType<WebhookEngine["listWaiters"]>>;

export function formatWaiters(list: WebhookWaiterList, offset: number, limit: number): string {
  const complete = offset === 0 && list.total <= limit;
  if (complete && list.waiters.length === 0) return "No runs are waiting on this endpoint.";

  const count = complete
    ? `${list.waiters.length} waiting`
    : `up to ${list.total} waiting; entries still being created are not listed`;
  const lines = [`## Webhook waiters (${count})\n`];
  for (const w of list.waiters) {
    const conditions = describeConditions(w);
    lines.push(
      `- ${plainId(w.id, WAITPOINT_ID, "webhook-waiter")} · expires ${w.expiresAt.toISOString()}`
    );
    if (conditions.match) {
      lines.push(`  Match: ${fenced(conditions.match, "webhook-waiter-match", RULE_CHARS)}`);
    }
    if (conditions.filter) {
      lines.push(`  Filter: ${fenced(conditions.filter, "webhook-waiter-filter", RULE_CHARS)}`);
    }
  }
  const next = offset + limit;
  if (next < list.total) {
    lines.push(
      `\nShowing entries ${offset + 1}–${next} of up to ${list.total}. Call again with cursor "${next}".`
    );
  }
  return lines.join("\n");
}

export function formatDeliveryList(
  deliveries: WebhookDeliveryListItem[],
  nextCursor: string | undefined
): string {
  if (deliveries.length === 0) {
    return nextCursor
      ? `No deliveries on this page. Call again with cursor "${nextCursor}" for older deliveries.`
      : "No deliveries match.";
  }

  const lines = ["## Webhook deliveries\n"];
  for (const d of deliveries) {
    const endpoint = d.endpoint ? ` · ${d.endpoint.declaredId}` : "";
    const test = d.isTest ? " · test" : "";
    lines.push(
      `- ${d.id} · ${d.status}${endpoint} · ${fenceUntrusted(d.externalDeliveryId, "webhook-delivery-id")} · ${d.createdAt.toISOString()}${test}`
    );
  }
  if (nextCursor) lines.push(`\nMore deliveries: call again with cursor "${nextCursor}".`);
  return lines.join("\n");
}

export function formatDelivery(d: WebhookDeliveryObject): string {
  const lines = [`## Delivery ${d.id}\n`];
  lines.push(`Status: ${d.status}${d.isTest ? " (test)" : ""}`);
  if (d.endpoint) lines.push(`Endpoint: ${d.endpoint.declaredId} (${d.endpoint.id})`);
  lines.push(
    `External delivery id: ${fenceUntrusted(d.externalDeliveryId, "webhook-delivery-id")}`
  );
  lines.push(`Received: ${d.createdAt.toISOString()}`);
  if (d.processedAt) lines.push(`Processed: ${d.processedAt.toISOString()}`);
  if (d.error) lines.push(`Error: ${fenceUntrusted(d.error, "webhook-delivery-error")}`);
  if (d.filterReason)
    lines.push(`Filtered: ${fenceUntrusted(d.filterReason, "webhook-filter-reason")}`);

  lines.push("\n### Targets");
  if (d.targets.length === 0) {
    lines.push("No subscribers or waiters to route to.");
  } else {
    for (const target of d.targets) lines.push(`- ${formatTarget(target)}`);
  }

  lines.push("\n### Event");
  if (d.event == null) {
    lines.push("Not captured.");
  } else {
    const json = JSON.stringify(d.event, null, 2);
    const body = json.length > EVENT_CHARS ? `${json.slice(0, EVENT_CHARS)}\n… (truncated)` : json;
    lines.push(fenceUntrusted(body, "webhook-event"));
  }

  const headers = Object.entries(d.headers ?? {});
  if (headers.length > 0) {
    lines.push("\n### Headers");
    const sorted = headers.sort(([a], [b]) => a.localeCompare(b));
    const text = sorted.map(([name, value]) => `- ${name}: ${value}`).join("\n");
    lines.push(fenceUntrusted(text, "webhook-headers"));
  }

  return lines.join("\n");
}

function formatTarget(t: WebhookDeliveryTargetObject): string {
  if (t.type === "waiter") {
    const w = t.waiters;
    const counts = w ? `${w.resumed} of ${w.matched} waiting runs resumed, ${w.failed} failed` : "";
    return `waiting runs · ${t.status}${counts ? ` · ${counts}` : ""}${t.error ? ` · ${fenceUntrusted(t.error, "webhook-target")}` : ""}`;
  }
  const parts = [`${t.id} (${t.type})`, t.status];
  if (t.runId) parts.push(`run ${t.runId}`);
  if (t.sessionId) parts.push(`session ${t.sessionId}`);
  if (t.reason) parts.push(fenceUntrusted(t.reason, "webhook-target"));
  if (t.error) parts.push(fenceUntrusted(t.error, "webhook-target"));
  return parts.join(" · ");
}

export function fenceSetupPrompt(
  prompt: string,
  endpoint: { tenantId: string | null; subscribers: { filter?: string | null }[] }
): string {
  let fenced = prompt;
  if (endpoint.tenantId) {
    fenced = fenced
      .split(`(tenant ${endpoint.tenantId})`)
      .join(`(tenant ${fenceUntrusted(endpoint.tenantId, "webhook-endpoint")})`);
  }
  for (const { filter } of endpoint.subscribers) {
    if (!filter) continue;
    fenced = fenced
      .split(`\`${filter}\``)
      .join(fenceUntrusted(filter, "webhook-subscriber-filter"));
  }
  return fenced;
}
