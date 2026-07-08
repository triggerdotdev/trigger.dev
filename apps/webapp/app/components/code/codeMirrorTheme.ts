import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export function darkTheme(): Extension {
  // Values come from the --color-editor-* theme palette in tailwind.css.
  const chalky = "var(--color-editor-type)",
    coral = "var(--color-editor-heading)",
    cyan = "var(--color-editor-operator)",
    invalid = "var(--color-editor-invalid)",
    ivory = "var(--color-editor-foreground)",
    stone = "var(--color-editor-comment)",
    malibu = "var(--color-editor-function)",
    sage = "var(--color-editor-string)",
    whiskey = "var(--color-editor-constant)",
    violet = "var(--color-editor-keyword)",
    lilac = "var(--color-editor-name)",
    darkBackground = "var(--color-editor-panel-background)",
    highlightBackground = "var(--color-editor-highlight-background)",
    background = "var(--color-editor-background)",
    tooltipBackground = "var(--color-editor-tooltip-background)",
    selection = "var(--color-editor-selection)",
    cursor = "var(--color-editor-cursor)",
    scrollbarTrack = "rgba(0,0,0,0)",
    scrollbarTrackActive = "var(--color-editor-scrollbar-track-active)",
    scrollbarThumb = "var(--color-editor-scrollbar-thumb)",
    scrollbarThumbActive = "var(--color-editor-scrollbar-thumb-active)",
    scrollbarBg = "rgba(0,0,0,0)";

  const jsonHeroEditorTheme = EditorView.theme(
    {
      "&": {
        color: ivory,
        backgroundColor: background,
      },

      ".cm-content": {
        caretColor: cursor,
        fontFamily: "Geist Mono Variable",
        fontSize: "14px",
      },

      ".cm-tooltip.cm-tooltip-lint": {
        backgroundColor: tooltipBackground,
      },

      ".cm-diagnostic": {
        padding: "4px 8px",
        color: ivory,
        fontFamily: "Geist Mono Variable",
        fontSize: "12px",
      },

      ".cm-diagnostic-error": {
        borderLeft: "2px solid var(--color-error)",
      },

      ".cm-lint-marker-error": {
        content: "none",
        backgroundColor: "var(--color-error)",
        height: "100%",
        width: "2px",
      },

      ".cm-lintPoint:after": {
        borderBottom: "4px solid var(--color-error)",
      },

      ".cm-cursor, .cm-dropCursor": { borderLeftColor: cursor },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: selection,
      },

      ".cm-panels": { backgroundColor: darkBackground, color: ivory },
      ".cm-panels.cm-panels-top": { borderBottom: "2px solid black" },
      ".cm-panels.cm-panels-bottom": { borderTop: "2px solid black" },

      ".cm-searchMatch": {
        backgroundColor: "var(--color-editor-search-match)",
        outline: "1px solid var(--color-editor-search-match-outline)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "var(--color-editor-search-match-selected)",
      },

      ".cm-activeLine": { backgroundColor: highlightBackground },
      ".cm-selectionMatch": { backgroundColor: "var(--color-editor-selection-match)" },

      "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: "var(--color-editor-matching-bracket)",
        outline: "1px solid var(--color-editor-matching-bracket-outline)",
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
        color: "var(--color-editor-fold-placeholder)",
      },

      ".cm-tooltip": {
        border: "none",
        marginTop: "6px",
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
      color: lilac,
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
        tags.bool,
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
      tag: [tags.atom, tags.special(tags.variableName)],
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
