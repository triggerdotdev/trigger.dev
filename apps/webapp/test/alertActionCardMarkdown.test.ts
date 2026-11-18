import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { alertActionMessage } from "~/components/alerts/alertActionCard";
import { loadStreamdownRenderer } from "~/components/code/StreamdownRenderer";

// Catches: another member's alert name rendering as markdown in the assistant's confirmation.
it("renders a markdown alert name as literal text", async () => {
  const name = "[x](https://evil.example)";
  const { default: Renderer } = await loadStreamdownRenderer();
  const text = alertActionMessage("call_1", "stop", name).parts[0].text;
  const html = renderToStaticMarkup(createElement(Renderer, null, text));
  expect(html).not.toContain("<a");
  expect(html).toContain(name);
});
