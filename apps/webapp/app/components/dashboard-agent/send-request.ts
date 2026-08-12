/** What to do with a prompt the panel asked the chat to send. */
export type SendRequestOutcome = "send" | "hold" | "skip";

/**
 * A click on a suggested prompt is consumed only once it has actually been sent. Marking it
 * consumed first loses the click whenever the chat can't take it yet — the message cap being
 * the case that has no other way back in — so an unsendable request is held for the next render.
 */
export function sendRequestOutcome(params: {
  requestSeq: number | undefined;
  consumedSeq: number | undefined;
  canSend: boolean;
}): SendRequestOutcome {
  if (params.requestSeq === undefined) return "skip";
  if (params.requestSeq === params.consumedSeq) return "skip";
  return params.canSend ? "send" : "hold";
}
