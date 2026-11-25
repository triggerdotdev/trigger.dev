// Code colors shared with the dashboard: "Trigger dark" (the palette the Mintlify docs use in
// docs/style.css) and "trigger.light" (the dashboard's light code tokens).
type Palette = {
  bg: string;
  fg: string;
  comment: string;
  keyword: string;
  storage: string;
  type: string;
  fn: string;
  variable: string;
  parameter: string;
  constant: string;
  property: string;
  string: string;
  number: string;
  punctuation: string;
  builtin: string;
  attribute: string;
  tag: string;
  regexp: string;
  invalid: string;
  link: string;
  inserted: string;
  deleted: string;
};

function theme(name: string, type: "dark" | "light", c: Palette) {
  const rule = (scope: string | string[], foreground: string, fontStyle?: string) => ({
    scope,
    settings: fontStyle ? { foreground, fontStyle } : { foreground },
  });
  return {
    name,
    type,
    colors: { "editor.background": c.bg, "editor.foreground": c.fg },
    settings: [
      { settings: { background: c.bg, foreground: c.fg } },
      rule(["comment", "punctuation.definition.comment"], c.comment, "italic"),
      rule(
        [
          "keyword",
          "keyword.control",
          "keyword.operator.new",
          "keyword.operator.expression",
          "keyword.operator.logical.python",
        ],
        c.keyword
      ),
      rule(["storage", "storage.type", "storage.modifier"], c.storage),
      rule(
        [
          "entity.name.type",
          "support.type",
          "support.class",
          "entity.name.class",
          "entity.other.inherited-class",
        ],
        c.type
      ),
      rule(
        ["entity.name.function", "support.function", "meta.function-call entity.name.function"],
        c.fn
      ),
      rule(["variable", "variable.other.readwrite", "meta.definition.variable"], c.variable),
      rule(["variable.parameter", "meta.parameters variable"], c.parameter),
      rule(
        ["constant", "constant.language", "variable.other.constant", "support.constant"],
        c.constant
      ),
      rule(
        [
          "variable.other.property",
          "variable.other.object.property",
          "meta.object-literal.key",
          "support.type.property-name",
          "entity.name.tag.yaml",
        ],
        c.property
      ),
      rule(["string", "string.template", "punctuation.definition.string"], c.string),
      rule(
        ["punctuation.definition.template-expression", "punctuation.section.embedded"],
        c.keyword
      ),
      rule("constant.numeric", c.number),
      rule(["punctuation", "meta.brace", "keyword.operator"], c.punctuation),
      rule(["support.variable", "variable.language", "support.type.builtin"], c.builtin),
      rule(["entity.other.attribute-name"], c.attribute),
      rule(["entity.name.tag", "support.class.component"], c.tag),
      rule(["string.regexp"], c.regexp),
      rule(["invalid"], c.invalid),
      rule(["markup.underline.link", "string.other.link"], c.link),
      rule(["markup.heading", "entity.name.section"], c.fn, "bold"),
      rule(["markup.bold"], c.fg, "bold"),
      rule(["markup.italic"], c.fg, "italic"),
      rule(["markup.inline.raw", "markup.fenced_code"], c.string),
      rule(["markup.inserted", "punctuation.definition.inserted"], c.inserted),
      rule(["markup.deleted", "punctuation.definition.deleted"], c.deleted),
    ],
  };
}

export const triggerDark = theme("trigger-dark", "dark", {
  bg: "#121317",
  fg: "#d4d4d4",
  comment: "#5f6570",
  keyword: "#e888f8",
  storage: "#e888f8",
  type: "#f770c6",
  fn: "#d9f07c",
  variable: "#cccbff",
  parameter: "#cccbff",
  constant: "#9b99ff",
  property: "#8b89ff",
  string: "#afec73",
  number: "#b5cea8",
  punctuation: "#878c99",
  builtin: "#e5c07b",
  attribute: "#c39eff",
  tag: "#9b99ff",
  regexp: "#d16969",
  invalid: "#f44747",
  link: "#826dff",
  inserted: "#afec73",
  deleted: "#f85149",
});

export const triggerLight = theme("trigger-light", "light", {
  bg: "#ffffff",
  fg: "#2e2e4b",
  comment: "#767a81",
  keyword: "#b114d3",
  storage: "#b114d3",
  type: "#b114d3",
  fn: "#6532f5",
  variable: "#404040",
  parameter: "#404040",
  constant: "#1e1e1e",
  property: "#222222",
  string: "#2e7d0a",
  number: "#262626",
  punctuation: "#5f6570",
  builtin: "#3080e0",
  attribute: "#222222",
  tag: "#6532f5",
  regexp: "#dc3545",
  invalid: "#dc3545",
  link: "#6532f5",
  inserted: "#2e7d0a",
  deleted: "#dc3545",
});

// Highlighted tokens carry a class instead of an inline style (lib/rehype-code-weight.ts): one
// class per theme rule, setting the same CSS variables shiki would put in the style attribute.
// The style strings match shiki's dual-theme output; a token whose style isn't listed keeps it.
function tokenStyle(light: Record<string, string>, dark: Record<string, string>) {
  const vars = (name: string, s: Record<string, string>) => {
    let out = `--shiki-${name}:${s.foreground!.toUpperCase()}`;
    if (s.fontStyle === "italic") out += `;--shiki-${name}-font-style:italic`;
    if (s.fontStyle === "bold") out += `;--shiki-${name}-font-weight:bold`;
    return out;
  };
  return `${vars("light", light)};${vars("dark", dark)}`;
}

export const tokenStyles: string[] = [
  ...new Set(
    triggerLight.settings.map((rule, i) =>
      tokenStyle(
        rule.settings as Record<string, string>,
        triggerDark.settings[i]!.settings as Record<string, string>
      )
    )
  ),
];

export const tokenClass = (i: number) => `sk${i}`;

export const tokenCss = tokenStyles.map((s, i) => `.${tokenClass(i)}{${s}}`).join("\n");
