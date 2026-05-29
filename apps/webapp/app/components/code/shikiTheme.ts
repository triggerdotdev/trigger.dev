import type { ThemeRegistrationAny } from "streamdown";

// Custom Shiki theme matching the Trigger.dev VS Code dark theme.
// Colors taken directly from the VS Code extension's tokenColors.
export const triggerDarkTheme: ThemeRegistrationAny = {
  name: "trigger-dark",
  type: "dark",
  colors: {
    "editor.background": "#212327",
    "editor.foreground": "#878C99",
    "editorLineNumber.foreground": "#484c54",
  },
  tokenColors: [
    // Control flow keywords: pink-purple
    {
      scope: [
        "keyword.control",
        "keyword.operator.delete",
        "keyword.other.using",
        "keyword.other.operator",
        "entity.name.operator",
      ],
      settings: { foreground: "#E888F8" },
    },
    // Storage type (const, let, var, function, class): purple
    {
      scope: "storage.type",
      settings: { foreground: "#8271ED" },
    },
    // Storage modifiers (async, export, etc.): purple
    {
      scope: ["storage.modifier", "keyword.operator.noexcept"],
      settings: { foreground: "#8271ED" },
    },
    // Keyword operator expressions (new, typeof, instanceof, etc.): purple
    {
      scope: [
        "keyword.operator.new",
        "keyword.operator.expression",
        "keyword.operator.cast",
        "keyword.operator.sizeof",
        "keyword.operator.instanceof",
        "keyword.operator.logical.python",
        "keyword.operator.wordlike",
      ],
      settings: { foreground: "#8271ED" },
    },
    // Types and namespaces: hot pink
    {
      scope: [
        "support.class",
        "support.type",
        "entity.name.type",
        "entity.name.namespace",
        "entity.name.scope-resolution",
        "entity.name.class",
        "entity.other.inherited-class",
      ],
      settings: { foreground: "#F770C6" },
    },
    // Functions: lime/yellow-green
    {
      scope: ["entity.name.function", "support.function"],
      settings: { foreground: "#D9F07C" },
    },
    // Variables and parameters: light lavender
    {
      scope: [
        "variable",
        "meta.definition.variable.name",
        "support.variable",
        "entity.name.variable",
        "constant.other.placeholder",
      ],
      settings: { foreground: "#CCCBFF" },
    },
    // Constants and enums: medium purple
    {
      scope: ["variable.other.constant", "variable.other.enummember"],
      settings: { foreground: "#9C9AF2" },
    },
    // this/self: purple-blue
    {
      scope: "variable.language",
      settings: { foreground: "#9B99FF" },
    },
    // Object literal keys: medium purple-blue
    {
      scope: "meta.object-literal.key",
      settings: { foreground: "#8B89FF" },
    },
    // Strings: sage green
    {
      scope: ["string", "meta.embedded.assembly"],
      settings: { foreground: "#AFEC73" },
    },
    // String interpolation punctuation: blue-purple
    {
      scope: [
        "punctuation.definition.template-expression.begin",
        "punctuation.definition.template-expression.end",
        "punctuation.section.embedded",
      ],
      settings: { foreground: "#7A78EA" },
    },
    // Template expression reset
    {
      scope: "meta.template.expression",
      settings: { foreground: "#d4d4d4" },
    },
    // Operators: gray (same as foreground)
    {
      scope: "keyword.operator",
      settings: { foreground: "#878C99" },
    },
    // Comments: olive gray
    {
      scope: "comment",
      settings: { foreground: "#6f736d" },
    },
    // Language constants (true, false, null, undefined): purple-blue
    {
      scope: "constant.language",
      settings: { foreground: "#9B99FF" },
    },
    // Numeric constants: light green
    {
      scope: [
        "constant.numeric",
        "keyword.operator.plus.exponent",
        "keyword.operator.minus.exponent",
      ],
      settings: { foreground: "#b5cea8" },
    },
    // Regex: dark red
    {
      scope: "constant.regexp",
      settings: { foreground: "#646695" },
    },
    // HTML/JSX tags: purple-blue
    {
      scope: "entity.name.tag",
      settings: { foreground: "#9B99FF" },
    },
    // Tag brackets: dark gray
    {
      scope: "punctuation.definition.tag",
      settings: { foreground: "#5F6570" },
    },
    // HTML/JSX attributes: light purple
    {
      scope: "entity.other.attribute-name",
      settings: { foreground: "#C39EFF" },
    },
    // Escape characters: gold
    {
      scope: "constant.character.escape",
      settings: { foreground: "#d7ba7d" },
    },
    // Regex string: dark red
    {
      scope: "string.regexp",
      settings: { foreground: "#d16969" },
    },
    // Storage: purple-blue
    {
      scope: "storage",
      settings: { foreground: "#9B99FF" },
    },
    // TS-specific: type casts, math/dom/json constants
    {
      scope: [
        "meta.type.cast.expr",
        "meta.type.new.expr",
        "support.constant.math",
        "support.constant.dom",
        "support.constant.json",
      ],
      settings: { foreground: "#9B99FF" },
    },
    // Markdown headings: purple-blue bold
    {
      scope: "markup.heading",
      settings: { foreground: "#9B99FF", fontStyle: "bold" },
    },
    // Markup bold: purple-blue
    {
      scope: "markup.bold",
      settings: { foreground: "#9B99FF", fontStyle: "bold" },
    },
    // Markup inline raw: sage green
    {
      scope: "markup.inline.raw",
      settings: { foreground: "#AFEC73" },
    },
    // Markup inserted: light green
    {
      scope: "markup.inserted",
      settings: { foreground: "#b5cea8" },
    },
    // Markup deleted: sage green
    {
      scope: "markup.deleted",
      settings: { foreground: "#AFEC73" },
    },
    // Markup changed: purple-blue
    {
      scope: "markup.changed",
      settings: { foreground: "#9B99FF" },
    },
    // Invalid: red
    {
      scope: "invalid",
      settings: { foreground: "#f44747" },
    },
    // JSX text content
    {
      scope: ["meta.jsx.children"],
      settings: { foreground: "#D7D9DD" },
    },
  ],
};
