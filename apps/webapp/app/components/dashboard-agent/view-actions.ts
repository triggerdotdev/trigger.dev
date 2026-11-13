// A navigate target is a plain string at the contract boundary, so only targets
// that parse become buttons: a hallucinated URI costs a button, never a dead click.
import {
  isTriggerUri,
  type ActionsBlockAction,
  type ChartAction,
  type InvestigationAction,
} from "@internal/dashboard-agent-contracts";
import { isProsePart } from "./prose-part";

type CardAction = ChartAction | ActionsBlockAction | InvestigationAction;

export function renderableActions<T extends CardAction>(actions: T[]): T[] {
  return actions.filter((action) => {
    const intent: CardAction["intent"] = action.intent;
    return intent.kind !== "navigate" || isTriggerUri(intent.target);
  });
}

export function withoutWatchActions<T extends CardAction>(actions: T[]): T[] {
  return actions.filter((action) => action.intent.kind !== "watch");
}

/**
 * "Keep digging" asks the agent to carry on — which is pointless once it already has.
 * A turn that renders an inconclusive card and then keeps answering leaves the button
 * offering work that is already done.
 */
export function answerContinuesAfter(parts: { type: string; text?: string }[], index: number) {
  return parts.slice(index + 1).some((part) => isProsePart(part));
}
