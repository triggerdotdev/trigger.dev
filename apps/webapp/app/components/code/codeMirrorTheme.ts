import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle } from "@codemirror/language";
import { tagHighlighter, tags } from "@lezer/highlight";
import { syntaxHighlighting } from "@codemirror/language";

export function darkTheme(): Extension {
  const chalky = "#e5c07b",
    coral = "#e06c75",
    cyan = "#56b6c2",
    invalid = "#ffffff",
    ivory = "#abb2bf",
    stone = "#7d8799",
    malibu = "#61afef",
    sage = "#98c379",
    whiskey = "#d19a66",
    violet = "#c678dd",
    darkBackground = "#21252b",
    highlightBackground = "rgba(234,179,8,0.1)",
    background = "#0f172a",
    tooltipBackground = "#353a42",
    selection = "rgb(71 85 105)",
    cursor = "#528bff";

  const jsonHeroEditorTheme = EditorView.theme(
    {
      "&": {
        color: ivory,
        backgroundColor: background,
      },

      ".cm-content": {
        caretColor: cursor,
        fontFamily: "monospace",
        fontSize: "14px",
      },

      ".cm-cursor, .cm-dropCursor": { borderLeftColor: cursor },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: selection },

      ".cm-panels": { backgroundColor: darkBackground, color: ivory },
      ".cm-panels.cm-panels-top": { borderBottom: "2px solid black" },
      ".cm-panels.cm-panels-bottom": { borderTop: "2px solid black" },

      ".cm-searchMatch": {
        backgroundColor: "#72a1ff59",
        outline: "1px solid #457dff",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "#6199ff2f",
      },

      ".cm-activeLine": { backgroundColor: highlightBackground },
      ".cm-selectionMatch": { backgroundColor: "#aafe661a" },

      "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: "#bad0f847",
        outline: "1px solid #515a6b",
      },

      ".cm-gutters": {
        backgroundColor: background,
        color: stone,
        border: "none",
      },

      ".cm-activeLineGutter": {
        backgroundColor: highlightBackground,
      },

      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: "none",
        color: "#ddd",
      },

      ".cm-tooltip": {
        border: "none",
        backgroundColor: tooltipBackground,
      },
      ".cm-tooltip .cm-tooltip-arrow:before": {
        borderTopColor: "transparent",
        borderBottomColor: "transparent",
      },
      ".cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: tooltipBackground,
        borderBottomColor: tooltipBackground,
      },
      ".cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": {
          backgroundColor: highlightBackground,
          color: ivory,
        },
      },
    },
    { dark: true }
  );

  /// The highlighting style for code in the JSON Hero theme.
  const jsonHeroHighlightStyle = HighlightStyle.define([
    { tag: tags.keyword, color: violet },
    {
      tag: [
        tags.name,
        tags.deleted,
        tags.character,
        tags.propertyName,
        tags.macroName,
      ],
      color: coral,
    },
    { tag: [tags.function(tags.variableName), tags.labelName], color: malibu },
    {
      tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)],
      color: whiskey,
    },
    { tag: [tags.definition(tags.name), tags.separator], color: ivory },
    {
      tag: [
        tags.typeName,
        tags.className,
        tags.number,
        tags.changed,
        tags.annotation,
        tags.modifier,
        tags.self,
        tags.namespace,
      ],
      color: chalky,
    },
    {
      tag: [
        tags.operator,
        tags.operatorKeyword,
        tags.url,
        tags.escape,
        tags.regexp,
        tags.link,
        tags.special(tags.string),
      ],
      color: cyan,
    },
    { tag: [tags.meta, tags.comment], color: stone },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.link, color: stone, textDecoration: "underline" },
    { tag: tags.heading, fontWeight: "bold", color: coral },
    {
      tag: [tags.atom, tags.bool, tags.special(tags.variableName)],
      color: whiskey,
    },
    {
      tag: [tags.processingInstruction, tags.string, tags.inserted],
      color: sage,
    },
    { tag: tags.invalid, color: invalid },
  ]);

  return [jsonHeroEditorTheme, syntaxHighlighting(jsonHeroHighlightStyle)];
}

export function lightTheme(): Extension[] {
  const stringColor = "text-[#53a053]",
    numberColor = "text-[#447bef]",
    variableColor = "text-[#a42ea2]",
    booleanColor = "text-[#e2574e]",
    coral = "text-[#e06c75]",
    invalid = "text-[#ffffff]",
    ivory = "text-[#abb2bf]",
    stone = "text-[#7d8799]",
    malibu = "text-[#61afef]",
    whiskey = "text-[#d19a66]",
    violet = "text-[#c678dd]",
    darkBackground = "text-[#21252b]",
    highlightBackground = "text-[#D0D0D0]",
    background = "text-[#ffffff]",
    tooltipBackground = "text-[#353a42]",
    selection = "text-[#D0D0D0]",
    cursor = "text-[#528bff]";

  const jsonHeroEditorTheme = EditorView.theme(
    {
      "&": {
        color: ivory,
        backgroundColor: background,
      },

      ".cm-content": {
        caretColor: cursor,
        fontFamily: "monospace",
        fontSize: "14px",
      },

      ".cm-cursor, .cm-dropCursor": { borderLeftColor: cursor },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: selection },

      ".cm-panels": { backgroundColor: darkBackground, color: ivory },
      ".cm-panels.cm-panels-top": { borderBottom: "2px solid black" },
      ".cm-panels.cm-panels-bottom": { borderTop: "2px solid black" },

      ".cm-searchMatch": {
        backgroundColor: "#72a1ff59",
        outline: "1px solid #457dff",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "#6199ff2f",
      },

      ".cm-activeLine": { backgroundColor: highlightBackground },
      ".cm-selectionMatch": { backgroundColor: "#aafe661a" },

      "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: "#bad0f847",
        outline: "1px solid #515a6b",
      },

      ".cm-gutters": {
        backgroundColor: background,
        color: stone,
        border: "none",
      },

      ".cm-activeLineGutter": {
        backgroundColor: highlightBackground,
      },

      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: "none",
        color: "#ddd",
      },

      ".cm-tooltip": {
        border: "none",
        backgroundColor: tooltipBackground,
      },
      ".cm-tooltip .cm-tooltip-arrow:before": {
        borderTopColor: "transparent",
        borderBottomColor: "transparent",
      },
      ".cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: tooltipBackground,
        borderBottomColor: tooltipBackground,
      },
      ".cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": {
          backgroundColor: highlightBackground,
          color: ivory,
        },
      },
    },
    { dark: false }
  );

  /// The highlighting style for code in the JSON Hero theme.
  const jsonHeroHighlightStyle = tagHighlighter([
    { tag: tags.keyword, class: violet },
    {
      tag: [
        tags.name,
        tags.deleted,
        tags.character,
        tags.propertyName,
        tags.macroName,
      ],
      class: variableColor,
    },
    {
      tag: [tags.function(tags.variableName), tags.labelName],
      class: malibu,
    },
    {
      tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)],
      class: whiskey,
    },
    { tag: [tags.definition(tags.name), tags.separator], class: ivory },
    {
      tag: [
        tags.typeName,
        tags.className,
        tags.number,
        tags.changed,
        tags.annotation,
        tags.modifier,
        tags.self,
        tags.namespace,
      ],
      class: numberColor,
    },
    {
      tag: [
        tags.operator,
        tags.operatorKeyword,
        tags.url,
        tags.escape,
        tags.regexp,
        tags.link,
        tags.special(tags.string),
      ],
      class: stringColor,
    },
    { tag: [tags.meta, tags.comment], class: stone },

    { tag: tags.link, class: stone },
    { tag: tags.heading, class: coral },
    {
      tag: [tags.atom, tags.bool, tags.special(tags.variableName)],
      class: booleanColor,
    },
    {
      tag: [tags.processingInstruction, tags.string, tags.inserted],
      class: stringColor,
    },
    { tag: tags.invalid, class: invalid },
  ]);

  return [jsonHeroEditorTheme, syntaxHighlighting(jsonHeroHighlightStyle)];
}
