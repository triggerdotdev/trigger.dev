// Turns a region of the running dashboard into static JSX for a docs figure.
//
// Load it into the dashboard tab (Chrome DevTools MCP `evaluate_script`, format "script",
// sourcePath = this file), then call it:
//
//   () => window.__figureCapture("<css selector>")             // JSX string
//   () => window.__figureCapture(el, { icons: "name" })        // svgs as <Icon name="..." /> placeholders
//
// What it does, so the output is safe inside docs prose:
// - keeps every class verbatim, except interaction-only ones (hover:, focus, active:,
//   transitions, cursors): a figure is a still frame.
// - turns semantic and interactive tags into div/span (a, button, h1-h6, p, ul, li, label,
//   table parts as display:table divs, input/textarea as a box with the value or placeholder).
// - drops attributes except class, and style values that size or colour the element.
// - inlines svgs as JSX (camelCased attributes).
// The output is a starting point: replace the dashboard's data with the docs' example data,
// cut what the figure doesn't need, and put data-mark on the elements the text points at.
(() => {
  const DROP_CLASS =
    /(^|:)(hover|focus|focus-visible|focus-within|active|group-hover|group-focus|peer-hover|peer-focus|disabled|group-disabled)(\/[\w-]+)?:|^(transition|duration-|ease-|delay-|cursor-|select-none|outline-hidden|focus-custom|touch-none|pointer-events-|will-change|animate-)/;
  const INLINE = new Set([
    "a",
    "span",
    "label",
    "code",
    "strong",
    "em",
    "b",
    "i",
    "small",
    "kbd",
    "abbr",
  ]);
  const TABLE = {
    table: "table",
    thead: "table-header-group",
    tbody: "table-row-group",
    tfoot: "table-footer-group",
    tr: "table-row",
    th: "table-cell",
    td: "table-cell",
    colgroup: null,
    col: null,
  };
  const SKIP = new Set(["script", "style", "template", "noscript", "colgroup", "col"]);
  const KEEP_STYLE =
    /^(width|height|min-width|max-width|min-height|grid-template-columns|background-color|color|border-color|font-size)$/;

  const camel = (s) => s.replace(/[-:]([a-z])/g, (_, c) => c.toUpperCase());
  const esc = (s) => s.replace(/[{}<>]/g, (c) => `{"${c}"}`);

  const classes = (el, extra) => {
    const list = (el.getAttribute("class") || "")
      .split(/\s+/)
      .filter((c) => c && !DROP_CLASS.test(c));
    if (extra) list.unshift(extra);
    return list.length ? ` className="${list.join(" ")}"` : "";
  };

  const style = (el) => {
    const s = el.getAttribute("style");
    if (!s) return "";
    const kept = s
      .split(";")
      .map((d) => d.split(":").map((x) => x.trim()))
      .filter(([k, v]) => k && v && KEEP_STYLE.test(k) && !v.includes("var(--sm-"));
    if (!kept.length) return "";
    return ` style={{ ${kept.map(([k, v]) => `${camel(k)}: ${JSON.stringify(v)}`).join(", ")} }}`;
  };

  const svg = (el, opts, pad) => {
    if (opts.icons === "name") return `${pad}<Icon name="TODO"${classes(el)} />`;
    const clone = el.cloneNode(true);
    clone.querySelectorAll("title").forEach((t) => t.remove());
    let html = clone.outerHTML
      .replace(/\s(class)="([^"]*)"/g, (_, __, v) => {
        const kept = v.split(/\s+/).filter((c) => c && !DROP_CLASS.test(c));
        return kept.length ? ` className="${kept.join(" ")}"` : "";
      })
      .replace(/\s(aria-hidden|data-[\w-]+|focusable)="[^"]*"/g, "")
      .replace(/\sstyle="[^"]*"/g, "")
      .replace(/\s([a-z]+[-:][a-z-:]+)=/g, (_, a) => ` ${camel(a)}=`)
      .replace(/<(\w+)([^>]*)><\/\1>/g, "<$1$2 />");
    return pad + html;
  };

  const walk = (node, opts, depth) => {
    const pad = "  ".repeat(depth);
    if (node.nodeType === 3) {
      const t = node.textContent.replace(/\s+/g, " ").trim();
      return t ? pad + esc(t) : "";
    }
    if (node.nodeType !== 1) return "";
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return "";
    if (el.getAttribute("aria-hidden") === "true" && tag !== "svg" && !el.textContent.trim())
      return "";
    const cs = getComputedStyle(el);
    if (cs.display === "none" || (cs.visibility === "hidden" && tag !== "svg")) return "";
    if (tag === "svg") return svg(el, opts, pad);
    if (tag === "img")
      return `${pad}<div${classes(el)}${style(el)} /> {/* img: ${el.getAttribute("alt") || el.getAttribute("src")} */}`;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = el.getAttribute("type");
      if (type === "checkbox" || type === "radio") {
        return `${pad}<div${classes(el)} /> {/* ${type}${el.checked ? " checked" : ""} */}`;
      }
      const value = el.value || "";
      const shown = value || el.getAttribute("placeholder") || "";
      const tone = value ? "" : "text-text-dimmed";
      return `${pad}<div${classes(el, tone)}${style(el)}>${esc(shown)}</div>`;
    }
    let out = INLINE.has(tag) ? "span" : "div";
    let extra = "";
    if (tag in TABLE) {
      out = "div";
      extra = TABLE[tag];
    }
    const kids = [...el.childNodes].map((c) => walk(c, opts, depth + 1)).filter(Boolean);
    const open = `${pad}<${out}${classes(el, extra)}${style(el)}`;
    if (!kids.length) return `${open} />`;
    return `${open}>\n${kids.join("\n")}\n${pad}</${out}>`;
  };

  window.__figureCapture = (root, opts = {}) => {
    const el = typeof root === "string" ? document.querySelector(root) : root;
    if (!el) return `/* nothing matches ${root} */`;
    const r = el.getBoundingClientRect();
    return (
      `{/* captured ${location.pathname} ${Math.round(r.width)}x${Math.round(r.height)} */}\n` +
      walk(el, opts, 0)
    );
  };
})();
