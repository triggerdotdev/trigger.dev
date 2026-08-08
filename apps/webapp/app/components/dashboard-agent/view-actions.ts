// A navigate target is a plain string at the contract boundary, so only targets
// that parse become buttons: a hallucinated URI costs a button, never a dead click.
import {
  isTriggerUri,
  type ActionsBlockAction,
  type ChartAction,
  type ViewBlock,
} from "@internal/dashboard-agent-contracts";

type CardAction = ChartAction | ActionsBlockAction;

export function renderableActions<T extends CardAction>(actions: T[]): T[] {
  return actions.filter((action) => {
    const intent: CardAction["intent"] = action.intent;
    return intent.kind !== "navigate" || isTriggerUri(intent.target);
  });
}

/**
 * An investigation card carries its own "watch for a repeat" button, and the model is
 * asked to end an unresolved answer with a watch offer — so an answer that does both
 * shows the same button twice. The card wins: it is the one with the pre-filled spec.
 */
export function cardAlreadyOffersWatch(blocks: ViewBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.type === "investigation" &&
      (block.capabilities?.actions ?? []).some((action) => action.intent.kind === "watch")
  );
}

/**
 * The same question across every card a turn renders. One `render_view` call can carry the
 * investigation card and another the actions block, so a per-call answer misses the pair.
 */
export function turnAlreadyOffersWatch(blockGroups: ViewBlock[][]): boolean {
  return blockGroups.some(cardAlreadyOffersWatch);
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
  return parts
    .slice(index + 1)
    .some((part) => part.type === "text" && (part.text ?? "").trim().length > 0);
}
