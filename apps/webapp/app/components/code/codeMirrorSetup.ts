import {
  highlightSpecialChars,
  drawSelection,
  highlightActiveLine,
  dropCursor,
  lineNumbers,
  highlightActiveLineGutter,
  keymap,
} from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { highlightSelectionMatches } from "@codemirror/search";
import { json as jsonLang } from "@codemirror/lang-json";
import { closeBrackets } from "@codemirror/autocomplete";
import { bracketMatching } from "@codemirror/language";
import { indentWithTab } from "@codemirror/commands";

export function getPreviewSetup(): Array<Extension> {
  return [
    jsonLang(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    highlightSelectionMatches(),
    lineNumbers(),
  ];
}

export function getViewerSetup(): Array<Extension> {
  return [drawSelection(), dropCursor(), bracketMatching(), lineNumbers()];
}

export function getEditorSetup(showLineNumbers = true, showHighlights = true): Array<Extension> {
  const options = [
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    closeBrackets(),
    keymap.of([indentWithTab]),
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
