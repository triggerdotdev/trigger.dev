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
    highlightBackground = "rgba(71,85,105,0.2)",
    background = "rgba(11, 16, 24 ,100)",
    tooltipBackground = "#353a42",
    selection = "rgb(71 85 105)",
    cursor = "#528bff",
    scrollbarTrack = "#0E1521",
    scrollbarTrackActive = "#131B2B",
    scrollbarThumb = "#293649",
    scrollbarThumbActive = "#3C4B62",
    scrollbarBg = "#0E1521";

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
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: selection,
      },

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
      ".cm-scroller": {
        scrollbarWidth: "thin",
        scrollbarColor: `${scrollbarThumb} ${scrollbarTrack}`,
      },
      ".cm-scroller::-webkit-scrollbar": {
        display: "block",
        width: "8px",
        height: "8px",
      },
      ".cm-scroller::-webkit-scrollbar-track": {
        backgroundColor: scrollbarTrack,
        borderRadius: "0",
      },
      ".cm-scroller::-webkit-scrollbar-track:hover": {
        backgroundColor: scrollbarTrackActive,
      },
      ".cm-scroller::-webkit-scrollbar-track:active": {
        backgroundColor: scrollbarTrackActive,
      },
      ".cm-scroller::-webkit-scrollbar-thumb": {
        backgroundColor: scrollbarThumb,
        borderRadius: "0",
      },
      ".cm-scroller::-webkit-scrollbar-thumb:hover": {
        backgroundColor: scrollbarThumbActive,
      },
      ".cm-scroller::-webkit-scrollbar-thumb:active": {
        backgroundColor: scrollbarThumbActive,
      },
      ".cm-scroller::-webkit-scrollbar-corner": {
        backgroundColor: scrollbarBg,
        borderRadius: "0",
      },
      ".cm-scroller::-webkit-scrollbar-corner:hover": {
        backgroundColor: scrollbarBg,
      },
      ".cm-scroller::-webkit-scrollbar-corner:active": {
        backgroundColor: scrollbarBg,
      },
    },
    { dark: true }
  );

  /// The highlighting style for code in the JSON Hero theme.
  const jsonHeroHighlightStyle = HighlightStyle.define([
    { tag: tags.keyword, color: violet },
    {
      tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName],
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
