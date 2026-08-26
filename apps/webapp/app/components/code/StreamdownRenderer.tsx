import { lazy } from "react";
import type { CodeHighlighterPlugin, UrlTransform } from "streamdown";
import type * as StreamdownModule from "streamdown";
import type * as StreamdownCodeModule from "@streamdown/code";
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
  return SAFE_LINK_SCHEMES.has(`${schemeMatch[1].toLowerCase()}:`) ? url : undefined;
};

const RETRY_DELAYS_MS = [250, 1000];

/** Retries a lazy import a few times before giving up, so a flaky chunk load doesn't crash the chat. */
export async function retryImport<T>(
  importer: () => Promise<T>,
  delaysMs: number[] = RETRY_DELAYS_MS
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await importer();
    } catch (error) {
      if (attempt >= delaysMs.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

const PlainTextFallback = ({ children }: { children: string }) => (
  <pre className="whitespace-pre-wrap break-words font-sans text-sm">{children}</pre>
);

type StreamdownRendererModule = {
  default: (props: { children: string; isAnimating?: boolean }) => JSX.Element;
};

export function loadStreamdownRenderer(
  load: () => Promise<
    [typeof StreamdownModule, typeof StreamdownCodeModule, typeof ShikiThemeModule]
  > = () => Promise.all([import("streamdown"), import("@streamdown/code"), import("./shikiTheme")]),
  delaysMs?: number[]
): Promise<StreamdownRendererModule> {
  return retryImport(load, delaysMs)
    .then(([{ Streamdown }, { createCodePlugin }, { triggerDarkTheme }]) => {
      // Type assertion needed: @streamdown/code and streamdown resolve different shiki
      // versions under pnpm, causing structurally-identical CodeHighlighterPlugin types
      // to be considered incompatible (different BundledLanguage string unions).
      const codePlugin = createCodePlugin({
        themes: [triggerDarkTheme, triggerDarkTheme],
      }) as unknown as CodeHighlighterPlugin;

      return {
        default: ({
          children,
          isAnimating = false,
        }: {
          children: string;
          isAnimating?: boolean;
        }) => (
          <Streamdown
            isAnimating={isAnimating}
            plugins={{ code: codePlugin }}
            controls={{ code: { copy: false, download: false } }}
            urlTransform={restrictModelUrls}
            linkSafety={{ enabled: false }}
          >
            {children}
          </Streamdown>
        ),
      };
    })
    .catch((error) => {
      // Re-raise as an unhandled rejection so StaleAssetRecovery can reload on deploy skew.
      queueMicrotask(() => void Promise.reject(error));
      return { default: PlainTextFallback };
    });
}

export const StreamdownRenderer = lazy(() => loadStreamdownRenderer());
