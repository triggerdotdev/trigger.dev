/**
 * The suggested-prompt registry. Import point for the panel and the routes;
 * nothing here touches the server (the promoted-slot flag reader is a separate
 * `.server.ts` module, imported only by loaders).
 */
export {
  contextualPrompts,
  contextualPromptsBySlot,
  formatAgo,
  formatMultiplier,
  GENERIC_PROMPTS,
  pageDefaultPrompts,
  pageSlotPrompts,
  PROMPT_SLOTS,
  promptForSignal,
  SIGNAL_PRIORITY,
  SIGNAL_SLOT,
  type PageSlotPrompts,
  type PromptSlot,
} from "./registry";
export {
  makeSuggestedPromptResolver,
  resolveSuggestedPrompts,
  resolveSuggestedPromptsBySlot,
  type ResolvedPromptSlot,
  type ResolvedSuggestedPrompt,
  type ResolveSuggestedPromptsOptions,
} from "./resolver";
export {
  FRESH_FAILURE_WINDOW_MS,
  queueAgentPageContext,
  runAgentPageContext,
} from "./page-mappers";
export { parsePromotedPrompt } from "./promoted";
export {
  dismissedPromptStorageKey,
  readDismissedPromptIds,
  writeDismissedPromptId,
} from "./dismissal";
