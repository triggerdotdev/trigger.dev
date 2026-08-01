/**
 * Keeps the chat layout library the only place transcript layout is decided.
 *
 * Source-level on purpose: the rule being enforced is "a consumer doesn't type
 * spacing classes", which is a property of the source, not of the rendered DOM.
 * Only the regions a consumer marks as transcript-level are checked — a panel
 * header or an empty state above/below the transcript is not the library's
 * business.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;

/** Files whose transcript regions must compose via chat-layout only. */
const CONSUMERS = ["DashboardAgentMessages.tsx"];

const LIBRARY = "chat-layout.tsx";

const REGION = /#region chat-layout transcript([\s\S]*?)#endregion chat-layout transcript/g;

/**
 * Tailwind spacing utilities: padding, margin, gap and the `space-*` rhythm
 * helpers. Matched only at a class-name boundary so `gap-2` is caught but
 * `min-w-0`, `overflow-y-auto` and prose like "space-y" in a comment are not.
 */
const SPACING_CLASS =
  /(?:^|[\s"'`])-?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-[\w./[\]%-]+/;

function read(file: string): string {
  return readFileSync(join(DIR, file), "utf8");
}

function transcriptRegions(source: string): string[] {
  return [...source.matchAll(REGION)].map((match) => match[1]!);
}

describe("chat-layout enforcement", () => {
  for (const consumer of CONSUMERS) {
    describe(consumer, () => {
      const source = read(consumer);
      const regions = transcriptRegions(source);

      it("marks its transcript-level code with a chat-layout region", () => {
        expect(regions.length).toBeGreaterThan(0);
        // A region that shrank to nothing would pass every other assertion.
        expect(regions.join("").length).toBeGreaterThan(200);
      });

      it("imports its layout from the library", () => {
        expect(source).toMatch(/from "\.{1,2}\/(?:\.\.\/)?chat-layout"/);
      });

      for (const [i, region] of regions.entries()) {
        it(`writes no spacing class in transcript region ${i + 1}`, () => {
          const offenders = region
            .split("\n")
            .filter((line) => SPACING_CLASS.test(line))
            .map((line) => line.trim());
          expect(
            offenders,
            `use a chat-layout micro-layout instead:\n${offenders.join("\n")}`
          ).toEqual([]);
        });
      }
    });
  }

  describe(LIBRARY, () => {
    const source = read(LIBRARY);

    it("is the single owner of the transcript's padding and rhythm", () => {
      // Pinned so a change to the transcript's geometry is a change to this
      // test, not a silent drift in one consumer.
      expect(source).toContain('const TRANSCRIPT_INSET_X = "px-4"');
      expect(source).toContain('const TRANSCRIPT_INSET_Y = "py-4"');
      expect(source).toContain('const TURN_GAP = "space-y-4"');
      expect(source).toContain('const TURN_BODY_GAP = "space-y-2"');
    });

    it("exports a component for every documented micro-layout", () => {
      for (const name of [
        "ChatTranscript",
        "ChatTurn",
        "ChatText",
        "ChatCardSlot",
        "ChatProgress",
        "ChatPendingTool",
        "ChatToolRow",
        "ChatNote",
        "ChatStatusLine",
        "ChatActionsRow",
      ]) {
        expect(source, name).toContain(`export function ${name}(`);
      }
    });

    it("renders assistant text as prose, not as a card", () => {
      // A box around every text answer made the whole transcript read as cards.
      // Only ChatCardSlot content is boxed now, so nothing here may reintroduce
      // the shared bubble.
      expect(source).not.toContain("ChatBubble");
    });

    it("gives the user bubble a grey surface, not the accent", () => {
      expect(source).toContain("bg-background-raised");
      expect(source).not.toMatch(/bg-indigo-\d/);
    });

    it("documents the composition rules", () => {
      expect(source).toContain("## Composition rules");
      expect(source).toContain("ChatTranscript\n *       ChatTurn*");
    });
  });
});
