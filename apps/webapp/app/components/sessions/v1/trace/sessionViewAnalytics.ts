export const SESSION_VIEW_EVENT = "session_view_action";

export type SessionViewAction =
  | "expand_all"
  | "load_all"
  | "search_used"
  | "budget_reached"
  | "open_run_page"
  | "retry"
  | "conversation_opened";

export type SessionViewer = "member" | "admin" | "impersonating";

export type SessionViewProperties = Record<string, string | number | boolean | undefined>;

export function sessionViewer(admin: boolean | undefined, impersonating: boolean): SessionViewer {
  if (impersonating) return "impersonating";
  return admin ? "admin" : "member";
}

export function sessionViewEventProperties(
  action: SessionViewAction,
  shared: { viewer: SessionViewer; runsShown?: number },
  extra: SessionViewProperties = {}
): SessionViewProperties {
  return { ...extra, action, viewer: shared.viewer, runs_shown: shared.runsShown };
}

export type BudgetHits = { freed: number; cutOff: number };
export type BudgetOutcome = "freed" | "cut_off";

/** Budget outcomes to report: each one once per page view, the first time it happens. */
export function newBudgetOutcomes(
  previous: BudgetHits,
  next: BudgetHits,
  reported: ReadonlySet<BudgetOutcome>
): BudgetOutcome[] {
  const outcomes: BudgetOutcome[] = [];
  if (next.freed > previous.freed && !reported.has("freed")) outcomes.push("freed");
  if (next.cutOff > previous.cutOff && !reported.has("cut_off")) outcomes.push("cut_off");
  return outcomes;
}

/** "Search used" fires when a search starts, not on every keystroke. */
export function searchStarted(
  previous: { text: string; errorsOnly: boolean },
  next: { text: string; errorsOnly: boolean }
): boolean {
  const wasSearching = previous.text !== "" || previous.errorsOnly;
  const isSearching = next.text !== "" || next.errorsOnly;
  return !wasSearching && isSearching;
}
