import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DiagnosisDocsAction } from "./RunDiagnosisCard";

function markup(label: string) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(DiagnosisDocsAction, {
          action: {
            kind: "docs",
            label,
            to: "https://example.com/help",
            destinationHost: "example.com",
          },
        })
      )
    )
  );
}

describe("diagnosis documentation actions", () => {
  it("bounds and isolates an untrusted label without hiding the destination host", () => {
    const label = `${"Read documentation ".repeat(20)}\u202eevil.test`;
    const html = markup(label);
    const labelStart = html.indexOf('<bdi dir="auto"');
    const hostStart = html.indexOf('<bdi dir="ltr" class="shrink-0 text-text-dimmed">');

    expect(html).toContain('href="https://example.com/help"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("max-w-[24ch] truncate");
    expect(html).toContain(label);
    expect(labelStart).toBeGreaterThan(-1);
    expect(hostStart).toBeGreaterThan(labelStart);
    expect(html.slice(hostStart)).toContain("(example.com)</bdi>");
  });
});
