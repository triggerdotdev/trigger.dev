import { describe, expect, it } from "vitest";
import { retryAction } from "./retry-action";

function user(id: string, ...texts: string[]) {
  return { id, role: "user", parts: texts.map((text) => ({ type: "text", text })) };
}

function assistant(id: string, text: string) {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

describe("retryAction", () => {
  it("re-sends the failed turn under its own id, never as a new message", () => {
    expect(retryAction([assistant("a1", "hi"), user("u2", "why is it slow?")])).toEqual({
      kind: "resend",
      messageId: "u2",
      text: "why is it slow?",
    });
  });

  it("joins the failed turn's text parts", () => {
    expect(retryAction([user("u1", "one", "two")])).toMatchObject({ text: "one\ntwo" });
  });

  it("regenerates when the agent already started answering", () => {
    expect(retryAction([user("u1", "why?"), assistant("a1", "partial")])).toEqual({
      kind: "regenerate",
    });
  });

  it("does nothing on an empty transcript, where there is no turn to retry", () => {
    expect(retryAction([])).toBeNull();
  });

  it("does nothing when the failed turn carries no text to re-send", () => {
    expect(retryAction([{ id: "u1", role: "user", parts: [] }])).toBeNull();
  });
});
