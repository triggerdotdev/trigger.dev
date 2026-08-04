import type { UIMessage } from "@ai-sdk/react";
import {
  VIEW_BLOCK_VERSION,
  type InvestigationBlock,
  type InvestigationCapabilities,
} from "@internal/dashboard-agent-contracts";
import { demoChatById, type demoFixtures, type DemoItem } from "~/components/dashboard-agent/demo";

/**
 * Fixture readers shared by the gallery pages.
 *
 * The message-level states already exist as demo chats, so the harnesses pull
 * their items rather than inventing transcripts.
 */

export function chatItems<K extends DemoItem["kind"]>(
  chatId: string,
  kind: K
): Extract<DemoItem, { kind: K }>[] {
  const chat = demoChatById(chatId);
  return (chat?.items ?? []).filter(
    (item): item is Extract<DemoItem, { kind: K }> => item.kind === kind
  );
}

export function chatMessages(chatId: string, take?: number): UIMessage[] {
  const items = chatItems(chatId, "messages");
  return (take === undefined ? items : items.slice(0, take)).flatMap((item) => item.messages);
}

/**
 * A demo investigation fixture as the real `investigation` block: the demo type
 * carries its identity inline (`investigationId` + `revision`) where the block
 * carries it in the envelope, so the mapping is a move, not a rewrite — which is
 * the point of having reviewed the demo payload.
 */
export function investigationBlock(
  fixture: (typeof demoFixtures.demoInvestigations)[keyof typeof demoFixtures.demoInvestigations],
  capabilities?: InvestigationCapabilities
): InvestigationBlock {
  const { investigationId, revision, ...investigation } = fixture;
  return {
    type: "investigation",
    id: investigationId,
    revision,
    version: VIEW_BLOCK_VERSION,
    investigation,
    ...(capabilities ? { capabilities } : {}),
  };
}
