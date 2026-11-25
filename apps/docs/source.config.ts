import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { pageSchema } from "fumadocs-core/source/schema";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins/remark-mdx-mermaid";
import { z } from "zod";
import { remarkMintlify } from "./lib/remark-mintlify";
import { remarkNpmTabs } from "./lib/remark-npm-tabs";
import { triggerDark, triggerLight } from "./lib/shiki-themes";
import { headingSlugger } from "./lib/slug";
import { twoslashTransformers } from "./lib/twoslash";
import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins/rehype-code";
import { rehypeLazyHovers, rehypeTokenClasses } from "./lib/rehype-code-weight";
import { rehypeHiddenToc } from "./lib/rehype-hidden-toc";

const sluggers = new WeakMap<object, (text: string) => string>();

// Content is read in place from trigger.dev/docs; snippets are compiled only when imported.
export const docs = defineDocs({
  dir: "../../docs",
  docs: {
    // Builds: each page's compiled body is its own chunk, loaded when the page renders. Eager bodies
    // put every page into one huge chunk that each route and build worker had to load.
    // Dev: eager. Turbopack dev builds every lazy chunk on the first request, and 430 of them
    // took twice as long as one big chunk. Read bodies through loadPage (lib/source.ts).
    async: process.env.NODE_ENV !== "development",
    files: ["**/*.mdx", "!snippets/**", "!node_modules/**"],
    schema: pageSchema.extend({
      sidebarTitle: z.string().optional(),
      openapi: z.string().optional(),
      hidden: z.boolean().optional(),
      noindex: z.boolean().optional(),
      url: z.string().optional(),
      mode: z.string().optional(),
      tag: z.string().optional(),
    }),
    // Static markdown (JSX kept as source); lib/source.ts inlines snippets for agents.
    postprocess: { includeProcessedMarkdown: { output: "string", headingIds: false } },
  },
});

export default defineConfig({
  mdxOptions: {
    // Snippets are rendered by other pages without props, so components come from a provider.
    providerImportSource: "docs-mdx-components", // alias in next.config.mjs
    remarkPlugins: (v) => [remarkNpmTabs, remarkMintlify, remarkMdxMermaid, ...v],
    // Heading ids as the previous site made them, so existing deep links keep working.
    remarkHeadingOptions: {
      slug(root, _heading, text) {
        let slug = sluggers.get(root);
        if (!slug) sluggers.set(root, (slug = headingSlugger()));
        return slug(text);
      },
    },
    // Images stay plain <img> tags; the img component adds the /docs base path.
    remarkImageOptions: false,
    // After rehype-code: token classes first, so popup HTML gets them too.
    rehypePlugins: [rehypeTokenClasses, rehypeLazyHovers, rehypeHiddenToc],
    rehypeCodeOptions: {
      themes: { light: triggerLight, dark: triggerDark },
      fallbackLanguage: "text",
      transformers: [...(rehypeCodeDefaultOptions.transformers ?? []), ...twoslashTransformers()],
    },
  },
});
