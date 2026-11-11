/**
 * The watch vocabulary moved into the contracts package so the agent's own
 * deterministic narration says the same sentences the dashboard does — the agent
 * cannot import the webapp, and a second vocabulary would drift within a release.
 *
 * Re-exported here because every webapp surface imports the presenter, not contracts.
 */
export {
  noteFor,
  presentResolvedWatch,
  watchConditionLabel,
  watchConfirmationBlockBody,
  watchNoteLine,
  watchTooltipLabel,
  type WatchResolvedInput,
} from "@internal/dashboard-agent-contracts";
