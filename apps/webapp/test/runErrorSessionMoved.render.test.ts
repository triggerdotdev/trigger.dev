import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { RunError } from "~/components/runs/v3/RunError";
import { supersededRunCancelReason } from "~/utils/sessionMove";

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, el)
      )
    )
  );
}

describe("RunError for a run its session moved away from", () => {
  it("shows the move as information and links the run the session continued in", () => {
    const raw = supersededRunCancelReason({
      movedToVersion: "20261109.18",
      newRunFriendlyId: "run_cmw9rwzno00ctjuwmzbelk7x3",
    });
    const html = render(
      createElement(RunError, { error: { type: "STRING_ERROR", raw }, status: "CANCELED" })
    );

    // Catches: a move shown in the red error box, as if the run had failed, with a run id that
    // can't be clicked.
    expect(html).toContain("Session moved");
    expect(html).not.toContain("text-rose-500");
    expect(html).not.toContain("bg-error");
    expect(html).toContain('href="/runs/run_cmw9rwzno00ctjuwmzbelk7x3"');
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "Moved to 20261109.18 by the skew protection threshold. Continued in run_cmw9rwzno00ctjuwmzbelk7x3"
    );
  });

  it("keeps any other cancel reason in the error panel", () => {
    const html = render(
      createElement(RunError, {
        error: { type: "STRING_ERROR", raw: "Canceled by user" },
        status: "CANCELED",
      })
    );
    expect(html).toContain("text-rose-500");
    expect(html).toContain("Canceled by user");
    expect(html).not.toContain("Session moved");
  });

  it("shows the move text as an error when the run failed rather than being canceled", () => {
    const raw = supersededRunCancelReason({
      movedToVersion: "1",
      newRunFriendlyId: "run_x",
    });
    const html = render(
      createElement(RunError, {
        error: { type: "STRING_ERROR", raw },
        status: "COMPLETED_WITH_ERRORS",
      })
    );

    // Catches: a task that throws the exact move text hiding its failure behind the "Session
    // moved" notice, with a link to a run id it chose.
    expect(html).not.toContain("Session moved");
    expect(html).toContain("text-rose-500");
    expect(html).not.toContain('href="/runs/run_x"');
    expect(html).toContain(raw);
  });
});
