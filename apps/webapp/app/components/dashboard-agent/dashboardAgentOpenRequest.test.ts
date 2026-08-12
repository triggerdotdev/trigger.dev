import { describe, expect, it } from "vitest";
import { consumeDeepLinkQuestion } from "./dashboardAgentOpenRequest";

const NAMES = ["aiHelp"];

/**
 * The reader is an effect over `useSearchParams`. Dropping the param is a navigation, so the
 * effect can run again on the original params before it commits; without a record of what was
 * already sent, the deep-linked question is asked twice.
 */
describe("consumeDeepLinkQuestion", () => {
  const params = (search: string) => new URLSearchParams(search);

  it("hands over the question the first time it sees it", () => {
    expect(consumeDeepLinkQuestion(params("?aiHelp=why+is+it+slow"), NAMES, null)).toEqual({
      question: "why is it slow",
      sent: "why is it slow",
    });
  });

  it("does not hand it over again while the param is still in the URL", () => {
    const first = consumeDeepLinkQuestion(params("?aiHelp=why"), NAMES, null);
    expect(first.question).toBe("why");
    expect(consumeDeepLinkQuestion(params("?aiHelp=why"), NAMES, first.sent).question).toBeNull();
  });

  it("keeps the record until the param is gone, however many renders that takes", () => {
    let sent: string | null = null;
    let asked = 0;
    for (let render = 0; render < 5; render++) {
      const result = consumeDeepLinkQuestion(params("?aiHelp=why"), NAMES, sent);
      sent = result.sent;
      if (result.question !== null) asked++;
    }
    expect(asked).toBe(1);
  });

  it("forgets the question once the URL no longer carries it, so a later visit works", () => {
    const first = consumeDeepLinkQuestion(params("?aiHelp=why"), NAMES, null);
    const cleared = consumeDeepLinkQuestion(params(""), NAMES, first.sent);
    expect(cleared).toEqual({ question: null, sent: null });
    expect(consumeDeepLinkQuestion(params("?aiHelp=why"), NAMES, cleared.sent).question).toBe(
      "why"
    );
  });

  it("asks a different question that arrives before the first is dropped", () => {
    const first = consumeDeepLinkQuestion(params("?aiHelp=why"), NAMES, null);
    expect(consumeDeepLinkQuestion(params("?aiHelp=how"), NAMES, first.sent).question).toBe("how");
  });

  it("has nothing to ask when no watched param is present", () => {
    expect(consumeDeepLinkQuestion(params("?other=x"), NAMES, null)).toEqual({
      question: null,
      sent: null,
    });
    expect(consumeDeepLinkQuestion(params("?aiHelp=why"), [], null).question).toBeNull();
  });

  it("ignores an empty question", () => {
    expect(consumeDeepLinkQuestion(params("?aiHelp="), NAMES, null).question).toBeNull();
  });
});
