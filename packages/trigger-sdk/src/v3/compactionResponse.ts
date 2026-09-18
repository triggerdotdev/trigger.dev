import type { UIMessage } from "ai";

/**
 * Inner compaction summarizes completed model steps, but the captured UI response
 * still contains every step. Trim that prefix before model-message conversion:
 * one step can produce zero, one or several model messages (hidden reasoning,
 * provider tools, custom tool outputs), so a model-message count is not a UI offset.
 * The full response is left untouched for display and transcript persistence.
 */
export function responseAfterCompaction<T extends UIMessage>(
  response: T,
  compactedSteps?: number,
  originalResponse?: UIMessage
): T {
  if (!compactedSteps) return response;

  // Approval and head-start continuations append new steps to the existing
  // assistant. Its original parts were also summarized, but are not in this
  // turn's prepareStep.steps. Count their markers separately. Prefixes without
  // markers are naturally skipped before the first new step.
  const originalSteps =
    originalResponse?.id === response.id
      ? originalResponse.parts.filter((part) => part.type === "step-start").length
      : 0;
  const stepsToSkip = originalSteps + compactedSteps;
  let step = 0;
  let start = response.parts.length;
  for (let i = 0; i < response.parts.length; i++) {
    if (response.parts[i]?.type === "step-start" && ++step > stepsToSkip) {
      start = i;
      break;
    }
  }
  // Injection/data events following the last summarized step precede the
  // next step-start. They happened after compaction and belong to the suffix,
  // including a stop before that next step ever started.
  while (start > 0 && response.parts[start - 1]?.type.startsWith("data-")) start--;
  return { ...response, parts: response.parts.slice(start) };
}
