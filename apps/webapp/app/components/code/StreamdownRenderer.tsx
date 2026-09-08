import { isTriggerUri } from "@internal/dashboard-agent-contracts";
import { createContext, lazy, useContext } from "react";
import type { CodeHighlighterPlugin, UrlTransform } from "streamdown";
import type * as StreamdownModule from "streamdown";
import type * as StreamdownCodeModule from "@streamdown/code";
import { createStaleAssetRecovery } from "~/components/StaleAssetRecovery";
import type * as ShikiThemeModule from "./shikiTheme";

const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * URL policy for model-authored markdown. A remote image is fetched the moment it
 * renders — no click — so it is a zero-click data beacon; we drop the src of any
 * non-local image. Links stay clickable but only for safe, human-followable schemes.
 * streamdown removes an attribute whose transform returns undefined, so no request fires.
 */
export const restrictModelUrls: UrlTransform = (url, key, node) => {
  const value = url.trim();
  const isImage = node.tagName === "img" || key === "src" || key === "srcset";
  // What the browser will actually resolve, which is not what `trim()` leaves: the URL parser
  // drops C0 controls (`trim()` keeps them) and reads `\` as `/` for special schemes, so
  // a leading-control `//evil.tld` and `\\evil.tld` both name a remote host. Classify on this; return the
  // original `url` untouched whenever it is allowed.
  const normalized = value
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/^[/\\]+/, (run) => "/".repeat(run.length));

  if (isImage) {
    // Inline images carry their own bytes; a relative path resolves to our own origin.
    if (/^data:/i.test(normalized) || /^blob:/i.test(normalized)) return url;
    // Absolute or protocol-relative means a remote host — strip it so nothing is fetched.
    if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) || normalized.startsWith("//")) return undefined;
    return url;
  }

  // Links: relative and protocol-relative are fine; otherwise require a safe scheme.
  if (normalized.startsWith("//")) return url;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
  if (!schemeMatch) return url;
  const scheme = `${schemeMatch[1].toLowerCase()}:`;
  if (scheme === "trigger:") return isTriggerUri(normalized) ? url : undefined;
  return SAFE_LINK_SCHEMES.has(scheme) ? url : undefined;
};

type TriggerLinkResolution = { label: string; url: string; external?: boolean };
type TriggerUriResolver = (uri: string) => TriggerLinkResolution | null;

const TriggerUriResolverContext = createContext<TriggerUriResolver | undefined>(undefined);

function TriggerAwareAnchor({ href, children }: { href?: string; children?: React.ReactNode }) {
  const resolveTriggerUri = useContext(TriggerUriResolverContext);

  if (!href || !isTriggerUri(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  const resolved = resolveTriggerUri?.(href) ?? null;
  if (!resolved) return children;
  if (resolved.external) {
    return (
      <a href={resolved.url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return <a href={resolved.url}>{children}</a>;
}

const STREAMDOWN_COMPONENTS = { a: TriggerAwareAnchor };

// Same shape the browser actually throws for a chunk fetch that 404s under asset skew
// (Vite/Rollup's dynamic-import wrapper, or the module-script equivalent).
const CHUNK_LOAD_ERROR =
  /dynamically imported module|Importing a module script failed|ChunkLoadError/i;

const PlainTextFallback = ({ children }: { children: string }) => (
  <pre className="whitespace-pre-wrap break-words font-sans text-sm">{children}</pre>
);

type StreamdownRendererModule = {
  default: (props: {
    children: string;
    isAnimating?: boolean;
    resolveTriggerUri?: TriggerUriResolver;
  }) => JSX.Element;
};

/**
 * Loads the renderer chunk once. A failed dynamic import is cached as failed by the
 * module map, so retrying the same specifier can't succeed — the only useful response
 * is falling back to plain text, and asking the user to reload if the failure looks
 * like asset skew (a rolling deploy rotated the chunk's hash out from under this page).
 */
export function loadStreamdownRenderer(
  load: () => Promise<
    [typeof StreamdownModule, typeof StreamdownCodeModule, typeof ShikiThemeModule]
  > = () => Promise.all([import("streamdown"), import("@streamdown/code"), import("./shikiTheme")])
): Promise<StreamdownRendererModule> {
  return load().then(
    (modules) => {
      try {
        const [{ Streamdown, defaultRehypePlugins }, { createCodePlugin }, { triggerDarkTheme }] =
          modules;
        // Type assertion needed: @streamdown/code and streamdown resolve different shiki
        // versions under pnpm, causing structurally-identical CodeHighlighterPlugin types
        // to be considered incompatible (different BundledLanguage string unions).
        const codePlugin = createCodePlugin({
          themes: [triggerDarkTheme, triggerDarkTheme],
        }) as unknown as CodeHighlighterPlugin;

        const rehypePlugins = Object.entries(defaultRehypePlugins).map(([key, entry]) => {
          if (key !== "sanitize") return entry;
          const [sanitizePlugin, sanitizeSchema] = entry as unknown as [
            unknown,
            { protocols?: Record<string, string[]> },
          ];
          return [
            sanitizePlugin,
            {
              ...sanitizeSchema,
              protocols: {
                ...sanitizeSchema.protocols,
                href: [...(sanitizeSchema.protocols?.href ?? []), "trigger"],
              },
            },
          ];
        }) as NonNullable<StreamdownModule.StreamdownProps["rehypePlugins"]>;

        function RenderedStreamdown({
          children,
          isAnimating = false,
          resolveTriggerUri,
        }: {
          children: string;
          isAnimating?: boolean;
          resolveTriggerUri?: TriggerUriResolver;
        }) {
          return (
            <TriggerUriResolverContext.Provider value={resolveTriggerUri}>
              <Streamdown
                isAnimating={isAnimating}
                plugins={{ code: codePlugin }}
                controls={{ code: { copy: false, download: false } }}
                urlTransform={restrictModelUrls}
                linkSafety={{ enabled: false }}
                rehypePlugins={rehypePlugins}
                components={STREAMDOWN_COMPONENTS}
              >
                {children}
              </Streamdown>
            </TriggerUriResolverContext.Provider>
          );
        }

        return { default: RenderedStreamdown };
      } catch (error) {
        console.error("StreamdownRenderer: failed to set up the renderer", error);
        return { default: PlainTextFallback };
      }
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (CHUNK_LOAD_ERROR.test(message)) {
        createStaleAssetRecovery().recover();
      }
      return { default: PlainTextFallback };
    }
  );
}

export const StreamdownRenderer = lazy(() => loadStreamdownRenderer());
