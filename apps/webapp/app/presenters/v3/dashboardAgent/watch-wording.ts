/**
 * The watch vocabulary moved into the contracts package so the agent's own
 * deterministic narration says the same sentences the dashboard does — the agent
 * cannot import the webapp, and a second vocabulary would drift within a release.
 *
 * Re-exported here because every webapp surface imports the presenter, not contracts.
 */
export {
  formatWatchCadence,
  
  
  
  formatWatchWindow,
  immediateWatchMessage,
  noteFor,
  presentResolvedWatch,
  WATCH_IN_CHAT_DELIVERY_LINE,
  WATCH_PRESENTATION_FALLBACK,
  
  shortFingerprint,
  watchConditionLabel,
  
  watchConfirmationBlockBody,
  watchDurationLabel,
  
  
  watchIdentityValue,
  
  watchNoteLine,
  watchOneShotBlockBody,
  
  watchSubjectLabel,
  
  watchTooltipLabel,
  
  
  type WatchResolvedInput,
  
} from "@internal/dashboard-agent-contracts";
