import type { UIMessage } from "@ai-sdk/react";
import {
  VIEW_BLOCK_VERSION,
  type InvestigationBlock,
  type InvestigationCapabilities,
} from "@internal/dashboard-agent-contracts";
import { demoChatById, type demoFixtures, type DemoItem } from "~/components/dashboard-agent/demo";

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
