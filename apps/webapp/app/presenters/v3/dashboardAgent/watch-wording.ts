/**
 * The watch vocabulary moved into the contracts package so the agent's own
 * deterministic narration says the same sentences the dashboard does — the agent
 * cannot import the webapp, and a second vocabulary would drift within a release.
 *
 * Re-exported here because every webapp surface imports the presenter, not contracts.
 */
export {
  formatWatchCadence,
  formatWatchDuration,
  formatWatchSla,
  formatWatchWait,
  formatWatchWindow,
  immediateWatchMessage,
  noteFor,
  presentResolvedWatch,
  WATCH_IN_CHAT_DELIVERY_LINE,
  WATCH_PRESENTATION_FALLBACK,
  WATCH_UPDATE_LABEL,
  watchConditionLabel,
  watchConditionWording,
  watchConfirmationBlockBody,
  watchDurationLabel,
  watchExternalNotificationLine,
  watchFollowUpLines,
  watchIdentityValue,
  watchLifetimeSentence,
  watchNoteLine,
  watchOneShotBlockBody,
  watchRequestSentence,
  watchSubjectLabel,
  watchSubline,
  watchTooltipLabel,
  type WatchConditionWording,
  type WatchPresentation,
  type WatchResolvedInput,
  type WatchSemanticIcon,
} from "@internal/dashboard-agent-contracts";
