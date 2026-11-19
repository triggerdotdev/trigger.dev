import { UrlElicitationRequiredError } from "@modelcontextprotocol/server";
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import type {
  McpApprovalLookup,
  McpConfirmationRecord,
  McpConfirmationStore,
} from "~/mcp/confirm/store.server";

// Mock module for "~/mcp/confirm/storeInstance.server":
// vi.mock("~/mcp/confirm/storeInstance.server", () => import("./helpers/mcpConfirm"));

const TTL_MS = 10 * 60 * 1000;

const state = {
  autoApprove: true,
  records: new Map<string, McpConfirmationRecord>(),
  approvals: new Map<string, string>(),
};

const approvalKey = (l: McpApprovalLookup) =>
  JSON.stringify([l.userId, l.tokenId, l.client, l.tool, l.argsDigest]);

const live = (record: McpConfirmationRecord | undefined) =>
  record && record.expiresAt > Date.now() ? record : undefined;

const store: McpConfirmationStore = {
  async createPending(record) {
    const existing = pending().find((r) => live(r) && approvalKey(r) === approvalKey(record));
    if (existing?.deniedAt) return { denied: true, id: existing.id };
    const id = existing?.id ?? `mcpc_${randomBytes(24).toString("base64url")}`;
    if (!existing) state.records.set(id, { ...record, id, expiresAt: Date.now() + TTL_MS });
    return { id, url: `https://cloud.test/mcp/confirm/${id}` };
  },
  async get(id, userId) {
    const record = live(state.records.get(id));
    return record?.userId === userId ? record : null;
  },
  async approve(id, userId) {
    const record = live(state.records.get(id));
    if (!record || record.userId !== userId || record.truncated || record.deniedAt) return false;
    if (!record.approvedAt && !record.consumedAt) {
      record.approvedAt = Date.now();
      state.approvals.set(approvalKey(record), id);
    }
    return true;
  },
  async deny(id, userId) {
    const record = live(state.records.get(id));
    if (
      !record ||
      record.userId !== userId ||
      record.approvedAt ||
      record.consumedAt ||
      record.deniedAt
    )
      return false;
    record.deniedAt = Date.now();
    record.expiresAt = record.deniedAt + 60 * 1000;
    return true;
  },
  async consumeApproved(lookup) {
    if (state.autoApprove)
      return { id: "mcpc_auto", preview: "<autoApprove: no preview recorded>" };
    const key = approvalKey(lookup);
    const record = live(state.records.get(state.approvals.get(key) ?? ""));
    state.approvals.delete(key);
    if (!record?.approvedAt || record.consumedAt || record.deniedAt) return null;
    record.consumedAt = Date.now();
    return { id: record.id, preview: record.preview };
  },
};

export const getMcpConfirmationStore = () => store;
export let mcpConfirmationErrorMode: "rpc-error" | "tool-error" = "rpc-error";

/**
 * Clears records. autoApprove approves without recording a preview, so a tool that calls
 * `staleApproval` must use `autoApprove: false` plus `approveAll()`; otherwise every confirmed call is stale.
 */
export function resetConfirmations({
  autoApprove,
  mode = "rpc-error",
}: {
  autoApprove: boolean;
  mode?: "rpc-error" | "tool-error";
}) {
  state.autoApprove = autoApprove;
  mcpConfirmationErrorMode = mode;
  state.records.clear();
  state.approvals.clear();
}

export function pending(): McpConfirmationRecord[] {
  return [...state.records.values()].filter((r) => !r.approvedAt && !r.consumedAt);
}

export async function approveAll() {
  for (const record of pending()) await store.approve(record.id, record.userId);
}

/** Asserts the call was held for confirmation and returns the pending id. */
export async function expectPending(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(UrlElicitationRequiredError);
  return (error as UrlElicitationRequiredError).elicitations[0]!.elicitationId as string;
}
