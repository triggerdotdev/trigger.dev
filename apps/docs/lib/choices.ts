// Site-wide reader choices (package manager, framework): tabs labeled with one of these share
// one selection across pages. The choice comes from `?pm=` / `?framework=`, then a cookie, then
// each tab group's first tab. No imports: used by the layout script, components and markdown routes.

export type ChoiceKind = "pm" | "framework";

type Option = { slug: string; match: RegExp };

const options: Record<ChoiceKind, Option[]> = {
  // Package manager tabs are labeled with the bare name.
  pm: ["npm", "pnpm", "yarn", "bun"].map((slug) => ({ slug, match: new RegExp(`^${slug}$`, "i") })),
  framework: [
    { slug: "nextjs", match: /\bnext\.?js\b/i },
    { slug: "remix", match: /\bremix\b|\breact router\b/i },
    { slug: "sveltekit", match: /\bsveltekit\b/i },
    { slug: "nuxt", match: /\bnuxt\b|\bnitro\b/i },
    { slug: "astro", match: /\bastro\b/i },
    { slug: "tanstack-start", match: /\btanstack start\b/i },
    { slug: "cloudflare-workers", match: /\bcloudflare workers?\b/i },
    { slug: "elysia", match: /\belysia\b/i },
    { slug: "koa", match: /\bkoa\b/i },
    { slug: "express", match: /\bexpress\b/i },
    { slug: "hono", match: /\bhono\b/i },
    { slug: "fastify", match: /\bfastify\b/i },
    { slug: "nestjs", match: /\bnest\.?js\b/i },
    { slug: "deno", match: /\bdeno\b/i },
    { slug: "bun", match: /^bun\b/i },
    { slug: "node", match: /\bnode(\.js|:http)\b/i },
  ],
};

const choiceKinds = Object.keys(options) as ChoiceKind[];
export const choiceCookie = (kind: ChoiceKind) => `docs-${kind}`;
export const isChoice = (kind: ChoiceKind, v: unknown): v is string =>
  typeof v === "string" && options[kind].some((o) => o.slug === v);

/** The option a tab label names, if any. */
function labelChoice(kind: ChoiceKind, label: string): string | undefined {
  return options[kind].find((o) => o.match.test(label.trim()))?.slug;
}

/**
 * The kind a tab group's labels belong to, and each label's option: at least two labels must name
 * different options of one kind, so a lone "Next.js" tab next to unrelated ones stays untouched.
 */
export function groupChoices(labels: string[]) {
  for (const kind of choiceKinds) {
    const slugs = labels.map((l) => labelChoice(kind, l));
    if (new Set(slugs.filter(Boolean)).size >= 2) return { kind, slugs };
  }
  return undefined;
}

/** Choices from a URL's query string, only known values. */
/** The reader's chosen option per kind (`?pm=pnpm`), when they chose one. */
export type Chosen = Partial<Record<ChoiceKind, string>>;

export function queryChoices(params: URLSearchParams) {
  const out: Chosen = {};
  for (const kind of choiceKinds) {
    const v = params.get(kind);
    if (isChoice(kind, v)) out[kind] = v;
  }
  return out;
}

/**
 * Runs in <head> before the body paints: puts the reader's choices on <html> as `data-pm` /
 * `data-framework`, which the CSS below uses to show the chosen tab before React hydrates.
 */
export const choiceScript = `(function(){try{var q=new URLSearchParams(location.search),d=document.documentElement,o=${JSON.stringify(
  Object.fromEntries(choiceKinds.map((k) => [k, options[k].map((o) => o.slug)]))
)};for(var k in o){var m=document.cookie.match(new RegExp("(?:^|; )docs-"+k+"=([^;]*)")),v=q.get(k)||(m&&m[1]);if(v&&o[k].indexOf(v)>=0)d.setAttribute("data-"+k,v)}}catch(e){}})()`;

/**
 * Written to .generated/choices.css by the index script. Before hydration, React's tabs show each group's first tab. These rules show the chosen one
 * instead, only in groups that have it, and stop applying once the tabs have taken the choice over.
 */
export const choiceCss = choiceKinds
  .flatMap((kind) =>
    options[kind].flatMap(({ slug }) => {
      const group = `html[data-${kind}="${slug}"]:not([data-choices-ready]) [data-choice-group="${kind}"]:has(> [role="tablist"] [data-choice-${kind}="${slug}"])`;
      const on = `[data-choice-${kind}="${slug}"]`;
      return [
        `${group} > [role="tabpanel"]:not(${on}){display:none!important}`,
        `${group} > [role="tabpanel"]${on}{display:block!important}`,
        `${group} > [role="tablist"] [role="tab"]:not(${on}){color:var(--color-fd-muted-foreground)!important;border-color:transparent!important}`,
        `${group} > [role="tablist"] [role="tab"]:not(${on}) > div{background:transparent!important}`,
        `${group} > [role="tablist"] [role="tab"]${on}{color:var(--color-fd-primary)!important;border-color:var(--color-fd-primary)!important}`,
        `${group} > [role="tablist"] [role="tab"]${on} > div{background:var(--color-fd-primary)!important}`,
      ];
    })
  )
  .join("\n");
