/**
 * A failed turn is recorded in the transcript by the agent, under the message id
 * `turn-error:{turn}`. Same arrangement as a wake's `wake:watch:…` id: the prefix
 * is the transport convention, recognised here so the panel can tell a stored
 * failure record apart from an ordinary answer.
 *
 * Live, a failure arrives as the stream's error chunk and `useChat` surfaces it as
 * the retry callout. The stored record is what a reload reads. Both must never show
 * at once.
 */
const TURN_ERROR_ID_PREFIX = "turn-error:";

export function isTurnErrorMessageId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(TURN_ERROR_ID_PREFIX);
}

/**
 * Whether the live retry callout should be drawn. It must not be, once the
 * transcript ends in the stored record of that same failure.
 */
export function shouldShowLiveTurnError(
  error: Error | undefined,
  messages: readonly { id: string }[]
): boolean {
  if (!error) return false;
  return !isTurnErrorMessageId(messages[messages.length - 1]?.id);
}
