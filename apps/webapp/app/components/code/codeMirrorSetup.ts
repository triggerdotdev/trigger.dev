import { closeBrackets } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { jsonParseLinter } from "@codemirror/lang-json";
import { bracketMatching } from "@codemirror/language";
import { type Diagnostic, linter, lintGutter, lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches } from "@codemirror/search";
import { Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  type EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";

function emptyAwareJsonLinter() {
  return (view: EditorView): Diagnostic[] => {
    const content = view.state.doc.toString().trim();

    // return no errors if content is empty
    if (!content) {
      return [];
    }

    return jsonParseLinter()(view);
  };
}

export function getEditorSetup(showLineNumbers = true, showHighlights = true): Array<Extension> {
  const options = [
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    closeBrackets(),
    lintGutter(),
    linter(emptyAwareJsonLinter()),
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
