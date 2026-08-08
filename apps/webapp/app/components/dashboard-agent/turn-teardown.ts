/** Why a chat with a turn in flight is going away. */
export type TurnTeardown = "stop-clicked" | "panel-closed" | "chat-switched" | "navigated-away";

/**
 * A turn that finishes behind a closed panel is what the launcher dot exists for, so only a
 * deliberate stop and leaving the page end it early.
 */
export function teardownCancelsTurn(reason: TurnTeardown): boolean {
  return reason === "stop-clicked" || reason === "navigated-away";
}

/**
 * The three unmounts look identical from inside React. A navigation has already moved the URL
 * by the time the cleanup runs; closing the panel and switching chat leave it alone, and since
 * both keep the turn they share one branch.
 */
export function unmountTeardown(paths: { renderedPath: string; livePath: string }): TurnTeardown {
  return paths.renderedPath === paths.livePath ? "panel-closed" : "navigated-away";
}
