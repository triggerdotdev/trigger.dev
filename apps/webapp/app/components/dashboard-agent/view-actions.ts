/**
 * Which of a card's actions become buttons.
 *
 * A navigate target is a plain string at the contract boundary, so only targets
 * that parse become buttons: a hallucinated URI costs a button, never a dead
 * click. Shared by the `actions` block and the chart's action row.
 */
import {
  isTriggerUri,
  type ActionsBlockAction,
  type ChartAction,
} from "@internal/dashboard-agent-contracts";

type CardAction = ChartAction | ActionsBlockAction;

export function renderableActions<T extends CardAction>(actions: T[]): T[] {
  return actions.filter((action) => {
    const intent: CardAction["intent"] = action.intent;
    return intent.kind !== "navigate" || isTriggerUri(intent.target);
  });
}
