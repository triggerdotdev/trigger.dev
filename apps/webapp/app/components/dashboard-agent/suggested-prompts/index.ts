/**
 * The suggested-prompt registry. Import point for the panel and the routes;
 * nothing here touches the server (the promoted-slot flag reader is a separate
 * `.server.ts` module, imported only by loaders).
 */
export {
  contextualPrompts,
  formatAgo,
  formatMultiplier,
  GENERIC_PROMPTS,
  pageDefaultPrompts,
  promptForSignal,
  SIGNAL_PRIORITY,
} from "./registry";
export {
  makeSuggestedPromptResolver,
  resolveSuggestedPrompts,
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
