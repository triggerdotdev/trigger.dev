import type { ThemeRegistrationAny } from "streamdown";

// Custom Shiki theme matching the Trigger.dev VS Code dark theme.
// Colors taken directly from the VS Code extension's tokenColors.
export const triggerDarkTheme: ThemeRegistrationAny = {
  name: "trigger-dark",
  type: "dark",
  colors: {
    "editor.background": "var(--color-code-background)",
    "editor.foreground": "var(--color-code-foreground)",
    "editorLineNumber.foreground": "var(--color-code-line-number)",
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
      settings: { foreground: "var(--color-code-keyword)" },
    },
    // Storage type (const, let, var, function, class): purple
    {
      scope: "storage.type",
      settings: { foreground: "var(--color-code-storage)" },
    },
    // Storage modifiers (async, export, etc.): purple
    {
      scope: ["storage.modifier", "keyword.operator.noexcept"],
      settings: { foreground: "var(--color-code-storage)" },
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
      settings: { foreground: "var(--color-code-storage)" },
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
      settings: { foreground: "var(--color-code-type)" },
    },
    // Functions: lime/yellow-green
    {
      scope: ["entity.name.function", "support.function"],
      settings: { foreground: "var(--color-code-function)" },
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
      settings: { foreground: "var(--color-code-variable)" },
    },
    // Constants and enums: medium purple
    {
      scope: ["variable.other.constant", "variable.other.enummember"],
      settings: { foreground: "var(--color-code-constant)" },
    },
    // this/self: purple-blue
    {
      scope: "variable.language",
      settings: { foreground: "var(--color-code-language)" },
    },
    // Object literal keys: medium purple-blue
    {
      scope: "meta.object-literal.key",
      settings: { foreground: "var(--color-code-object-key)" },
    },
    // Strings: sage green
    {
      scope: ["string", "meta.embedded.assembly"],
      settings: { foreground: "var(--color-code-string)" },
    },
    // String interpolation punctuation: blue-purple
    {
      scope: [
        "punctuation.definition.template-expression.begin",
        "punctuation.definition.template-expression.end",
        "punctuation.section.embedded",
      ],
      settings: { foreground: "var(--color-code-template-punctuation)" },
    },
    // Template expression reset
    {
      scope: "meta.template.expression",
      settings: { foreground: "var(--color-code-plain)" },
    },
    // Operators: gray (same as foreground)
    {
      scope: "keyword.operator",
      settings: { foreground: "var(--color-code-foreground)" },
    },
    // Comments: olive gray
    {
      scope: "comment",
      settings: { foreground: "var(--color-code-comment)" },
    },
    // Language constants (true, false, null, undefined): purple-blue
    {
      scope: "constant.language",
      settings: { foreground: "var(--color-code-language)" },
    },
    // Numeric constants: light green
    {
      scope: [
        "constant.numeric",
        "keyword.operator.plus.exponent",
        "keyword.operator.minus.exponent",
      ],
      settings: { foreground: "var(--color-code-number)" },
    },
    // Regex: dark red
    {
      scope: "constant.regexp",
      settings: { foreground: "var(--color-code-regexp-constant)" },
    },
    // HTML/JSX tags: purple-blue
    {
      scope: "entity.name.tag",
      settings: { foreground: "var(--color-code-language)" },
    },
    // Tag brackets: dark gray
    {
      scope: "punctuation.definition.tag",
      settings: { foreground: "var(--color-code-muted)" },
    },
    // HTML/JSX attributes: light purple
    {
      scope: "entity.other.attribute-name",
      settings: { foreground: "var(--color-code-attribute)" },
    },
    // Escape characters: gold
    {
      scope: "constant.character.escape",
      settings: { foreground: "var(--color-code-escape)" },
    },
    // Regex string: dark red
    {
      scope: "string.regexp",
      settings: { foreground: "var(--color-code-regexp)" },
    },
    // Storage: purple-blue
    {
      scope: "storage",
      settings: { foreground: "var(--color-code-language)" },
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
      settings: { foreground: "var(--color-code-language)" },
    },
    // Markdown headings: purple-blue bold
    {
      scope: "markup.heading",
      settings: { foreground: "var(--color-code-language)", fontStyle: "bold" },
    },
    // Markup bold: purple-blue
    {
      scope: "markup.bold",
      settings: { foreground: "var(--color-code-language)", fontStyle: "bold" },
    },
    // Markup inline raw: sage green
    {
      scope: "markup.inline.raw",
      settings: { foreground: "var(--color-code-string)" },
    },
    // Markup inserted: light green
    {
      scope: "markup.inserted",
      settings: { foreground: "var(--color-code-number)" },
    },
    // Markup deleted: sage green
    {
      scope: "markup.deleted",
      settings: { foreground: "var(--color-code-string)" },
    },
    // Markup changed: purple-blue
    {
      scope: "markup.changed",
      settings: { foreground: "var(--color-code-language)" },
    },
    // Invalid: red
    {
      scope: "invalid",
      settings: { foreground: "var(--color-code-invalid)" },
    },
    // JSX text content
    {
      scope: ["meta.jsx.children"],
      settings: { foreground: "var(--color-code-jsx-text)" },
    },
  ],
};
