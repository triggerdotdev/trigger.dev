import type {
  BlockContent,
  Blockquote,
  Heading,
  List,
  ListItem,
  Nodes,
  Paragraph,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import { deployCommands, exampleFromHref } from "./remark-deploy-example";

type Estree = {
  body: Array<{ type: string; expression?: EstreeExpr }>;
  comments?: unknown[];
};
type EstreeExpr = { type: string; value?: unknown; elements?: EstreeExpr[] };
type JsxAttr = {
  type: string;
  name?: string;
  value?: string | null | { value: string; data?: { estree?: Estree } };
};
type Jsx = {
  type: "mdxJsxFlowElement" | "mdxJsxTextElement";
  name: string | null;
  attributes: JsxAttr[];
  children: RootContent[];
};
type Expression = {
  type: "mdxFlowExpression" | "mdxTextExpression";
  value: string;
  data?: { estree?: Estree };
};
type Any = RootContent & { children?: RootContent[]; data?: Record<string, unknown> };

export type AgentMdxOptions = {
  /** Absolute docs root, e.g. https://trigger.dev/docs */
  docsUrl: string;
  /** The page's URL under the docs root, e.g. /ai-chat/quick-start */
  pageUrl: string;
  /** The page's content file, e.g. guides/examples/x.mdx (example pages get the deploy commands). */
  pagePath?: string;
  /** Pages that only send readers elsewhere (`url` frontmatter), by docs path: links go there. */
  external?: ReadonlyMap<string, string>;
};

const ALERTS: Record<string, string> = {
  Note: "NOTE",
  Info: "NOTE",
  Callout: "NOTE",
  Tip: "TIP",
  Check: "TIP",
  Warning: "WARNING",
  Danger: "CAUTION",
};

// snippets/feature-status.jsx: its text lives in the component, not the MDX.
const FEATURE_STATUS: Record<string, [string, string]> = {
  PrivateBeta: ["Private beta.", "This feature is only available to some organizations right now."],
  RollingOut: [
    "Rolling out.",
    "This feature is being enabled gradually and may not be available for your organization yet.",
  ],
};

const text = (value: string): PhrasingContent => ({ type: "text", value });
const para = (children: PhrasingContent[]): Paragraph => ({ type: "paragraph", children });
const strong = (children: PhrasingContent[]): PhrasingContent => ({ type: "strong", children });

/** Attribute text with backticks as inline code (titles like "Run the CLI `init` command"). */
const inline = (s: string): PhrasingContent[] =>
  s
    .split(/(`[^`]+`)/)
    .filter(Boolean)
    .map((p) =>
      p.startsWith("`") && p.endsWith("`") ? { type: "inlineCode", value: p.slice(1, -1) } : text(p)
    );

/** A literal JS value as text: strings, numbers, booleans and arrays of them. */
function literal(e: EstreeExpr | undefined): string | undefined {
  if (e?.type === "Literal") return String(e.value);
  if (e?.type === "ArrayExpression") {
    const items = e.elements?.map(literal);
    return items?.every((i) => i !== undefined) ? items.join(", ") : undefined;
  }
  return undefined;
}

/** An attribute's value as text; "true" for a bare flag like `required`. */
function attr(node: Jsx, name: string): string | undefined {
  const a = node.attributes.find((x) => x.type === "mdxJsxAttribute" && x.name === name);
  if (!a) return undefined;
  if (a.value == null) return "true";
  if (typeof a.value === "string") return a.value;
  return literal(a.value.data?.estree?.body[0]?.expression) ?? a.value.value;
}

const isPhrasing = (n: RootContent) =>
  [
    "text",
    "inlineCode",
    "emphasis",
    "strong",
    "delete",
    "link",
    "linkReference",
    "image",
    "imageReference",
    "break",
    "html",
    "footnoteReference",
    "mdxTextExpression",
    "mdxJsxTextElement",
  ].includes(n.type);

/** Block children, with loose phrasing runs wrapped in paragraphs. */
function blocks(children: RootContent[]): BlockContent[] {
  const out: BlockContent[] = [];
  let run: PhrasingContent[] = [];
  const flush = () => {
    if (run.some((n) => n.type !== "text" || n.value.trim())) out.push(para(run));
    run = [];
  };
  for (const c of children) {
    if (isPhrasing(c)) run.push(c as PhrasingContent);
    else {
      flush();
      out.push(c as BlockContent);
    }
  }
  flush();
  return out;
}

/** A one-item list whose item starts with `head`, then `: ` and the first paragraph of `body`. */
function item(head: PhrasingContent[], body: RootContent[], merge: string): List {
  const rest = blocks(body);
  const first = rest[0]?.type === "paragraph" ? (rest.shift() as Paragraph).children : [];
  const lead = para(first.length ? [...head, text(": "), ...first] : head);
  const li: ListItem = { type: "listItem", spread: false, children: [lead, ...rest] };
  return { type: "list", ordered: false, spread: false, children: [li], data: { merge } as never };
}

function alert(kind: string, children: RootContent[]): Blockquote {
  const marker = { ...para([{ type: "html", value: `[!${kind}]` }]), data: { alert: true } };
  return { type: "blockquote", children: [marker as Paragraph, ...blocks(children)] };
}

function deployExample(folder: string, commands: string): RootContent[] {
  return [
    para([strong([text("Deploy this example to your project")])]),
    para([
      text("Copies "),
      { type: "inlineCode", value: folder },
      text(
        " from GitHub, installs it, and deploys its tasks to your project's production environment."
      ),
    ]),
    { type: "code", lang: "bash", meta: null, value: commands },
    para([
      text("If the example has a "),
      { type: "inlineCode", value: ".env.example" },
      text(
        ", set those variables in your project's environment variables before deploying. To run the tasks on your machine instead, use "
      ),
      { type: "inlineCode", value: "dev" },
      text(" in place of "),
      { type: "inlineCode", value: "deploy" },
      text("."),
    ]),
  ];
}

type Ctx = AgentMdxOptions & { deployPending: boolean };

/** One MDX node as plain markdown nodes; its children are already converted. */
function convert(node: Any, ctx: Ctx): RootContent[] {
  if (node.type === "mdxjsEsm") return [];
  if (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") {
    const { value, data } = node as unknown as Expression;
    const estree = data?.estree;
    // `{/* comment */}` renders nothing; `{" "}` renders its string.
    if (estree && !estree.body.length) return [];
    const lit = literal(estree?.body[0]?.expression);
    if (lit !== undefined) return [text(lit)];
    return [text(`{${value}}`)];
  }
  if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return [node];

  const el = node as unknown as Jsx;
  const kids = el.children;
  const flow = el.type === "mdxJsxFlowElement";
  const name = el.name ?? "";

  switch (name) {
    case "Icon":
      return [];
    case "br":
      return flow ? [] : [{ type: "break" }];
    case "a": {
      const href = attr(el, "href");
      const link: PhrasingContent = {
        type: "link",
        url: href ?? "",
        children: kids.flatMap((k) =>
          k.type === "paragraph" ? k.children : isPhrasing(k) ? [k as PhrasingContent] : []
        ),
      };
      return href ? (flow ? [para([link])] : [link]) : kids;
    }
    case "img": {
      const src = attr(el, "src");
      if (!src) return [];
      const img: PhrasingContent = { type: "image", url: src, alt: attr(el, "alt") ?? "" };
      return flow ? [para([img])] : [img];
    }
    case "video":
    case "iframe": {
      const src =
        attr(el, "src") ??
        kids
          .map((k) => (k as unknown as Jsx).attributes?.find((a) => a.name === "src")?.value)
          .find((v): v is string => typeof v === "string");
      if (!src) return [];
      const label = attr(el, "title") ?? (name === "video" ? "Video" : "Embedded content");
      const link: PhrasingContent = { type: "link", url: src, children: [text(label)] };
      return flow ? [para([link])] : [link];
    }
  }

  // Inline elements keep their content; block components below need a flow position.
  if (!flow) return kids;

  if (ALERTS[name]) {
    const title = attr(el, "title");
    return [alert(ALERTS[name], title ? [para([strong(inline(title))]), ...kids] : kids)];
  }
  if (FEATURE_STATUS[name]) {
    const [lead, body] = FEATURE_STATUS[name];
    return [alert("WARNING", [para([strong([text(lead)]), text(` ${body}`)]), ...kids])];
  }

  switch (name) {
    case "Step": {
      const heading: Heading = {
        type: "heading",
        depth: 3,
        children: inline(attr(el, "title") ?? ""),
        data: { step: true } as never,
      };
      return [heading, ...kids];
    }
    case "Steps": {
      let n = 0;
      for (const k of kids as Any[]) {
        if (k.type !== "heading" || !k.data?.step) continue;
        delete k.data.step;
        (k as Heading).children.unshift(text(`${++n}. `));
      }
      return kids;
    }
    case "Card": {
      const href = attr(el, "href");
      const title = inline(attr(el, "title") ?? href ?? "");
      const head = href
        ? [{ type: "link", url: href, children: title } as PhrasingContent]
        : [strong(title)];
      const out: RootContent[] = [item(head, kids, "card")];
      const example = ctx.deployPending && href ? exampleFromHref(href) : null;
      if (example) {
        ctx.deployPending = false;
        out.push(...deployExample(example.folder, deployCommands(example)));
      }
      return out;
    }
    case "ParamField":
    case "ResponseField": {
      const where = ["path", "query", "header"].find((k) => attr(el, k) !== undefined);
      const field = attr(el, where ?? "") ?? attr(el, "body") ?? attr(el, "name") ?? "";
      const def = attr(el, "default");
      const facts = [
        attr(el, "type"),
        where,
        attr(el, "required") === "true" ? "required" : undefined,
        attr(el, "deprecated") === "true" ? "deprecated" : undefined,
        def !== undefined ? `default: ${def}` : undefined,
      ].filter(Boolean);
      const head: PhrasingContent[] = [{ type: "inlineCode", value: field }];
      if (facts.length) head.push(text(` (${facts.join(", ")})`));
      return [item(head, kids, "field")];
    }
    case "Update": {
      const label = attr(el, "label") ?? "";
      const version = attr(el, "description");
      const tags = attr(el, "tags");
      // The entry's own headings sit under its version heading.
      const nest = (n: Any) => {
        if (n.type === "heading")
          (n as Heading).depth = Math.min(6, n.depth + 1) as Heading["depth"];
        n.children?.forEach((c) => nest(c as Any));
      };
      kids.forEach((k) => nest(k as Any));
      return [
        {
          type: "heading",
          depth: 2,
          children: [text(version ? `${version} (${label})` : label)],
        },
        ...(tags ? [para([text(`Tags: ${tags}`)])] : []),
        ...kids,
      ];
    }
    case "Tab":
    case "Accordion": {
      const title = attr(el, "title");
      return title ? [para([strong(inline(title))]), ...kids] : kids;
    }
    case "CodeGroup":
      return kids.flatMap((k) => {
        if (k.type !== "code" || !k.meta) return [k];
        const label = /title="([^"]*)"/.exec(k.meta)?.[1] ?? k.meta.trim();
        return [para([strong([text(label)])]), k];
      });
    case "Frame": {
      const caption = attr(el, "caption");
      return caption ? [...kids, para([{ type: "emphasis", children: inline(caption) }])] : kids;
    }
    case "Visibility":
      // `for="agents"` is the markdown's; `for="humans"` only renders on the page.
      return attr(el, "for") === "humans" ? [] : kids;
  }
  // CardGroup, Tabs, AccordionGroup, Expandable, RequestExample, div and the rest: their content.
  return kids;
}

/** Converts children bottom-up, so a parent sees its children as markdown. */
function walk(parent: Parent, ctx: Ctx) {
  const out: RootContent[] = [];
  for (let child of parent.children as Any[]) {
    // A component written on one line (`<Note>text</Note>`) parses as inline JSX in a paragraph.
    if (child.type === "paragraph") {
      const solid = child.children!.filter(
        (c) => !(c.type === "text" && !(c as { value: string }).value.trim())
      );
      const only = solid[0] as unknown as Jsx | undefined;
      if (
        solid.length === 1 &&
        only?.type === "mdxJsxTextElement" &&
        /^[A-Z]/.test(only.name ?? "")
      )
        child = {
          ...only,
          type: "mdxJsxFlowElement",
          children: [para(only.children as PhrasingContent[])],
        } as never;
    }
    if (child.children) walk(child as Parent, ctx);
    for (const node of convert(child, ctx)) {
      const prev = out.at(-1) as Any | undefined;
      const merge = (node as Any).data?.merge;
      if (merge && prev?.type === "list" && prev.data?.merge === merge)
        (prev as List).children.push(...(node as List).children);
      else out.push(node);
    }
  }
  parent.children = out as never;
}

/**
 * A link or image target as an absolute URL. Docs page links point at the page's `.md`, so they
 * work outside the site (agents, llms-full); anchors are kept.
 */
export function absoluteUrl(url: string, opts: AgentMdxOptions, page = true) {
  if (!url || /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) return url;
  const root = new URL(opts.docsUrl);
  const base = root.pathname.replace(/\/$/, "");
  let abs: URL;
  if (url.startsWith("/"))
    abs = new URL(
      `${base}${url === base || url.startsWith(`${base}/`) ? url.slice(base.length) : url}`,
      root
    );
  else abs = new URL(url, `${opts.docsUrl}${opts.pageUrl}`);
  if (page && abs.origin === root.origin) {
    let path = abs.pathname.replace(/\/$/, "");
    if (path === base) path = `${base}/introduction`;
    const external = path.startsWith(`${base}/`) && opts.external?.get(path.slice(base.length));
    if (external) return external;
    // Files (images, the OpenAPI spec, llms.txt) keep their path; pages get `.md`.
    if (path.startsWith(`${base}/`) && !/\.\w+$/.test(path)) abs.pathname = `${path}.md`;
  }
  return abs.href;
}

const processor = remark().use(remarkMdx).use(remarkGfm);
const stringifier = remark()
  .use(remarkGfm)
  .data("settings", {
    bullet: "-",
    emphasis: "_",
    fences: true,
    listItemIndent: "one",
    rule: "-",
    // `> [!NOTE]` and the callout's first line stay together, as GFM alerts need.
    join: [
      (left: Nodes, _right: Nodes, parent: Nodes) =>
        parent.type === "blockquote" && (left as Any).data?.alert ? 0 : undefined,
    ],
  });

/**
 * Page markdown (MDX with components) as plain markdown for agents: components become headings,
 * GFM alerts, lists and labelled fences, code nested in them comes out unindented, MDX comments
 * go, and every link and image is absolute.
 */
export function agentMarkdown(mdx: string, opts: AgentMdxOptions): string {
  let tree: Root;
  try {
    tree = processor.parse(mdx);
  } catch (error) {
    // Unparseable MDX would fail the page build first; keep the text rather than drop the page.
    console.error(`agent markdown: could not parse ${opts.pageUrl}: ${String(error)}`);
    return mdx;
  }
  const ctx: Ctx = { ...opts, deployPending: !!opts.pagePath?.startsWith("guides/") };
  walk(tree, ctx);
  const fix = (n: Any) => {
    if (n.type === "link" || n.type === "definition") n.url = absoluteUrl(n.url, opts);
    else if (n.type === "image") n.url = absoluteUrl(n.url, opts, false);
    n.children?.forEach((c) => fix(c as Any));
  };
  tree.children.forEach((c) => fix(c as Any));
  return stringifier.stringify(tree);
}
