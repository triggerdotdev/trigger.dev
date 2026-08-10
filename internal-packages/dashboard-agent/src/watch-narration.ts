import {
  presentResolvedWatch,
  type WatchObservedOutcome,
  type WatchPresentation,
  type WatchResolution,
} from "@internal/dashboard-agent-contracts";

/**
 * How a resolved watch is said.
 *
 * "Queue drained: 0 pending after 42 minutes" is a fact the check already
 * established, and the sentence for it is already written — in the contracts'
 * watch vocabulary, which every other surface (card, banner, toast, email) reads.
 * So a good or merely factual outcome is narrated here, with no model call at all.
 *
 * A model earns its call only where the fact has to be turned into what to do about
 * it. That is Haiku with the wake alone, never Sonnet with the whole conversation:
 * the wake carries every number the sentence may use.
 */

/** Which lane a wake takes. */
export type WatchNarrationPlan =
  /** Said from the contracts' wording. No model call. */
  | { model: "none"; text: string; presentation: WatchPresentation }
  /** One or two sentences from Haiku, given the wake and nothing else. */
  | { model: "haiku"; presentation: WatchPresentation }
  /** The consented-investigation wake: the wake and the findings must read as one. */
  | { model: "sonnet" };

export type NarratableWake = {
  kind: string;
  identity: string;
  resolution: WatchResolution;
  observed?: WatchObservedOutcome;
  note?: string;
  /** The user pre-approved an investigation and it has already been started. */
  startsInvestigation: boolean;
};

/**
 * The stock next step per category. Deliberately generic: a specific suggestion is
 * exactly the judgement a model is for, and this lane is the one where there is
 * nothing to judge.
 */
function nextStep(presentation: WatchPresentation): string {
  switch (presentation.category) {
    case "positive":
      return "Nothing to do — I've stopped watching.";
    // A neutral outcome is an answer without a problem in it: the watched thing is
    // gone, cancelled, or was never readable.
    case "neutral":
      return "I've stopped watching. Ask me if you want another watch set up.";
    case "attention":
      return "Ask me to look into it if you want the why.";
  }
}

/**
 * The whole wake message, when no model is needed.
 *
 * Only the next step: the wake banner above it already states the headline and the
 * user's note, and each fact is said once per wake.
 */
export function deterministicWakeNarration(wake: NarratableWake): {
  text: string;
  presentation: WatchPresentation;
} {
  const presentation = presentResolvedWatch({
    kind: wake.kind,
    identity: wake.identity,
    resolution: wake.resolution,
    observed: wake.observed ?? null,
  });
  return { text: nextStep(presentation), presentation };
}

/**
 * Which lane this wake takes.
 *
 * - A consented investigation goes to Sonnet: the wake has to promise the findings
 *   that its own next message delivers, and the two must read as one voice.
 * - An outcome that needs attention goes to Haiku: the fact is known, but saying
 *   what it means for the user is a judgement.
 * - Everything else — the condition became true, or the answer is simply "that's
 *   gone" — is said from the contracts' wording.
 */
export function planWatchNarration(wake: NarratableWake): WatchNarrationPlan {
  if (wake.startsInvestigation) return { model: "sonnet" };

  const { text, presentation } = deterministicWakeNarration(wake);
  if (presentation.category === "attention") return { model: "haiku", presentation };
  return { model: "none", text, presentation };
}
