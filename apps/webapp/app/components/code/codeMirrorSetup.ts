import { closeBrackets } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches } from "@codemirror/search";
import { Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";

export function getEditorSetup(showLineNumbers = true, showHighlights = true): Array<Extension> {
  const options = [
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    closeBrackets(),
    Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            return true;
          },
          preventDefault: false,
        },
      ])
    ),
    keymap.of([indentWithTab, ...lintKeymap]),
  ];

  if (showLineNumbers) {
    options.push(lineNumbers());
  }

  if (showHighlights) {
    options.push([
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      highlightActiveLine(),
      highlightSelectionMatches(),
    ]);
  }

  return options;
}
