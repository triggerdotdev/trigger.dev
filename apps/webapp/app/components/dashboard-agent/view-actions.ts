// A navigate target is a plain string at the contract boundary, so only targets
// that parse become buttons: a hallucinated URI costs a button, never a dead click.
import {
  agentIntentSchema,
  isTriggerUri,
  type ActionsBlockAction,
  type ChartAction,
  type ReportViewModelPayload,
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
  return blocks.some((block) => {
    if (block.type === "investigation") {
      return (block.capabilities?.actions ?? []).some((action) => action.intent.kind === "watch");
    }
    return block.type === "report" && reportOffersRecoveryWatch(block.vm);
  });
}

/**
 * The report card's watch button isn't in the block — `ReportView` grows it from the
 * view model, for a health report with something to recover from. Same condition here,
 * so the button the user will see is the one the guard counts. A predicate, so a caller
 * building the recovery spec keeps the narrowed severity.
 */
export function reportOffersRecoveryWatch(
  vm: ReportViewModelPayload
): vm is ReportViewModelPayload & { summary: { severity: "warn" | "crit" } } {
  return (
    vm.title === "health" && (vm.summary.severity === "warn" || vm.summary.severity === "crit")
  );
}

/**
 * The same question across every card a turn renders. One `render_view` call can carry the
 * investigation card and another the actions block, so a per-call answer misses the pair.
 */
export function turnAlreadyOffersWatch(blockGroups: ViewBlock[][]): boolean {
  return blockGroups.some(cardAlreadyOffersWatch);
}

/**
 * `schedule_watch` opens the pre-filled card itself, so a button repeating it is dead.
 * A rejected spec returns an error instead of an intent: no card opens, so the button stays.
 */
export function turnProposesWatch(
  parts: ReadonlyArray<{ type?: string; state?: string; output?: unknown }>
): boolean {
  return parts.some(
    (part) =>
      part.type === "tool-schedule_watch" &&
      part.state === "output-available" &&
      agentIntentSchema.safeParse((part.output as { intent?: unknown } | undefined)?.intent).success
  );
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
