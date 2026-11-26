import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import * as mintlify from "./mintlify";
import { Mermaid } from "./mermaid";
import { CodeSample } from "./code-block";
import { DeployExample } from "./deploy-example";
import { TypeHover } from "./type-hover";
import { SdkType } from "./sdk-type";
import { DashboardAnchor } from "./dashboard-anchor";
import { withBase } from "@/lib/base-path";
import { personalizationEnabled, productionDashboardOrigin } from "@/lib/dashboard-link";

const components = {
  ...defaultMdxComponents,
  ...mintlify,
  Mermaid,
  // Type hover popups on SDK code samples (lib/twoslash.ts, lib/rehype-code-weight.ts).
  TypeHover,
  SdkType,
  pre: CodeSample,
  // Added after example repo cards by lib/remark-deploy-example.ts.
  DeployExample,
  // Dashboard links land in the signed-in reader's own project.
  a: ({ href, ...props }: ComponentProps<"a">) =>
    personalizationEnabled && href?.startsWith(productionDashboardOrigin) ? (
      <DashboardAnchor href={href} {...props} />
    ) : (
      <defaultMdxComponents.a href={href} {...props} />
    ),
  // Mintlify accepts these aliases or unknown names without failing.
  Warn: mintlify.Warning,
  // Markdown images always carry alt text (possibly empty); a JSX <img> without one is decorative.
  img: ({ src, alt = "", ...props }: ComponentProps<"img">) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={withBase(typeof src === "string" ? src : undefined)}
      alt={alt}
      loading="lazy"
      {...props}
    />
  ),
  video: ({ src, ...props }: ComponentProps<"video">) => (
    // oxlint-disable-next-line jsx-a11y/media-has-caption -- The MDX videos are silent screen recordings; a <track> written in the MDX passes through as a child.
    <video src={withBase(src)} {...props} />
  ),
  source: ({ src, ...props }: ComponentProps<"source">) => (
    <source src={withBase(src)} {...props} />
  ),
} satisfies MDXComponents;

// Snippet .jsx files (feature-status.jsx) use Mintlify components as globals, as Mintlify allows.
Object.assign(globalThis, mintlify);

export function getMDXComponents(extra?: MDXComponents): MDXComponents {
  return { ...components, ...extra };
}

export const useMDXComponents = getMDXComponents;
