import { ArrowTopRightOnSquareIcon, BookOpenIcon } from "@heroicons/react/20/solid";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  DashboardPanelHeader,
  PANEL_TITLE_CLASS,
} from "~/components/dashboard-agent/DashboardPanelChrome";
import { LinkButton } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";
import { useFeatureFlags } from "~/hooks/useFeatureFlags";
import { useProject } from "~/hooks/useProject";
import { currentThemeMode, type ThemeMode } from "~/hooks/useThemeMode";
import { docsPath } from "~/utils/pathBuilder";

const PANEL_WIDTH = 480;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 900;
// Narrower than page plus panel, the panel overlays the page instead of squeezing it.
const PAGE_MIN_WIDTH = 560;
const OVERLAY_BELOW = PAGE_MIN_WIDTH + PANEL_WIDTH;

type DocsPanelContext = { open: (path: string) => void; isOpen: boolean; docsOrigin: string };

const DocsPanelContext = createContext<DocsPanelContext | null>(null);

/**
 * Props for a docs link (`LinkButton`, `TextLink`): with the docs panel on, a plain click opens the
 * page in the panel; otherwise, and on a modified click, it's the usual new-tab link.
 */
export function useDocsLink() {
  const panel = useContext(DocsPanelContext);
  return useCallback(
    (path: string) => ({
      // The panel's origin, so a modified click opens the same docs site the panel shows.
      to: panel ? `${panel.docsOrigin}/docs/${path.replace(/^\//, "")}` : docsPath(path),
      onClick: panel
        ? (event: MouseEvent) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            // A modal dialog covers the panel, so a link inside one stays a new-tab link.
            if ((event.currentTarget as Element).closest('[role="dialog"]')) return;
            event.preventDefault();
            panel.open(path);
          }
        : undefined,
    }),
    [panel]
  );
}

/** True while the docs panel shows a page, so the button that opened it can hide. */
function useDocsPanelOpen() {
  return useContext(DocsPanelContext)?.isOpen ?? false;
}

/** A page header's docs button: opens the panel, and hides while the panel already shows docs. */
export function DocsHeaderButton({ path, children }: { path: string; children: ReactNode }) {
  const docsLink = useDocsLink();
  const open = useDocsPanelOpen();
  if (open) return null;
  return (
    <LinkButton variant="docs/small" LeadingIcon={BookOpenIcon} {...docsLink(path)}>
      {children}
    </LinkButton>
  );
}

/** The docs page a docs link points at, embedded beside the page (behind `hasDocsPanel`). */
export function DocsPanel({ docsOrigin, children }: { docsOrigin: string; children: ReactNode }) {
  const enabled = useFeatureFlags().hasDocsPanel === true;
  if (!enabled) return children;
  return <DocsPanelFrame docsOrigin={docsOrigin}>{children}</DocsPanelFrame>;
}

// Sent by apps/docs/lib/embed.ts: keep the two types in step.
type EmbedPageMessage = { type: "trigger-docs:page"; title: string; path: string };

function DocsPanelFrame({ docsOrigin, children }: { docsOrigin: string; children: ReactNode }) {
  const project = useProject();
  // The page asked for, and the page showing (links inside the panel move it on).
  const [requested, setRequested] = useState<{
    path: string;
    seq: number;
    theme: ThemeMode;
  } | null>(null);
  const [showing, setShowing] = useState<{ path: string; title: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(PANEL_WIDTH);
  const iframe = useRef<HTMLIFrameElement>(null);
  const isOpen = requested !== null;
  const container = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState(false);

  // Measured only while open: a state change during hydration would drop the page's Suspense boundaries.
  useEffect(() => {
    const element = container.current;
    if (!isOpen || !element) return;
    const observer = new ResizeObserver(([entry]) =>
      setOverlay((entry?.contentRect.width ?? Infinity) < OVERLAY_BELOW)
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isOpen]);

  const open = useCallback((path: string) => {
    const clean = `/${path.replace(/^\//, "")}`;
    const width = container.current?.getBoundingClientRect().width;
    if (width !== undefined) setOverlay(width < OVERLAY_BELOW);
    // Read on open, not through useThemeMode: its first effect would update the page mid-hydration.
    const theme = currentThemeMode();
    setRequested((current) => ({ path: clean, seq: (current?.seq ?? 0) + 1, theme }));
    setShowing({ path: clean, title: "Docs" });
  }, []);
  const close = useCallback(() => setRequested(null), []);
  const context = useMemo(
    () => ({ open, isOpen, docsOrigin: new URL(docsOrigin).origin }),
    [open, isOpen, docsOrigin]
  );

  useEffect(() => {
    if (!isOpen) return;
    const docs = new URL(docsOrigin).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== docs || event.source !== iframe.current?.contentWindow) return;
      const data = event.data as Partial<EmbedPageMessage> | null;
      if (data?.type !== "trigger-docs:page" || typeof data.path !== "string") return;
      setShowing({ path: data.path, title: typeof data.title === "string" ? data.title : "Docs" });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isOpen, docsOrigin]);

  const resizeTo = useCallback((next: number) => {
    const available = container.current?.getBoundingClientRect().width ?? Infinity;
    const max = Math.min(PANEL_MAX_WIDTH, available - PAGE_MIN_WIDTH);
    setWidth(Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(max, next))));
  }, []);
  const onHandlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onHandlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const right = container.current?.getBoundingClientRect().right;
    if (dragging && right !== undefined) resizeTo(right - event.clientX);
  };
  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") resizeTo(width + 16);
    else if (event.key === "ArrowRight") resizeTo(width - 16);
    else return;
    event.preventDefault();
  };

  let src: string | undefined;
  if (requested) {
    const url = new URL(`/docs/embed${requested.path}`, docsOrigin);
    url.searchParams.set("project", project.externalRef);
    url.searchParams.set("theme", requested.theme);
    src = url.toString();
  }

  const panel = requested && showing && (
    <div className="flex h-full flex-col bg-background-bright">
      <DashboardPanelHeader
        title={
          <div className="flex min-w-0 items-center gap-1.5 pl-1">
            <BookOpenIcon className="size-4 shrink-0 text-text-dimmed" />
            {/* The page shows its own title, so the header just names the panel. */}
            <span className={PANEL_TITLE_CLASS}>Docs</span>
          </div>
        }
        actions={
          <LinkButton
            variant="minimal/small"
            to={new URL(`/docs${showing.path}`, docsOrigin).toString()}
            TrailingIcon={ArrowTopRightOnSquareIcon}
          >
            Open in new tab
          </LinkButton>
        }
        onClose={close}
      />
      <iframe
        key={requested.seq}
        ref={iframe}
        src={src}
        title={`Docs: ${showing.title}`}
        allow="clipboard-write"
        // Scripts and its own origin (storage, credentialed calls) for the docs app, forms for its
        // inputs, and links that leave it: new tabs (unsandboxed) and dashboard links that navigate
        // this page on a click.
        // oxlint-disable-next-line react/iframe-missing-sandbox -- The docs are served from another origin than the dashboard, so the frame can't reach this element to lift its sandbox.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
        // The iframe would swallow the pointer while the handle is dragged across it.
        className={cn("min-h-0 w-full flex-1 border-0", dragging && "pointer-events-none")}
      />
    </div>
  );

  // A plain flex row, not a ResizablePanelGroup: the splitter measures and updates on mount, which
  // during hydration would drop the page's Suspense boundaries. The page keeps its slot, so opening
  // and closing never remounts it.
  return (
    <DocsPanelContext.Provider value={context}>
      <div ref={container} className="relative flex h-full min-h-0">
        <div className="h-full min-w-0 flex-1">{children}</div>
        {panel && !overlay && (
          <>
            {/* Looks like ResizableHandle: a 1px line, indigo on hover, three dots. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize docs panel"
              aria-valuenow={width}
              aria-valuemin={PANEL_MIN_WIDTH}
              aria-valuemax={PANEL_MAX_WIDTH}
              tabIndex={0}
              onPointerDown={onHandlePointerDown}
              onPointerMove={onHandlePointerMove}
              onPointerUp={() => setDragging(false)}
              onPointerCancel={() => setDragging(false)}
              onKeyDown={onHandleKeyDown}
              className="group relative flex w-0.75 shrink-0 cursor-col-resize touch-none items-center justify-center focus-custom before:absolute before:left-px before:top-0 before:h-full before:w-px before:bg-grid-bright after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2"
            >
              <div
                className={cn(
                  "pointer-events-none absolute left-0 top-0 z-10 h-full w-0.75 bg-indigo-500 opacity-0 transition-opacity group-hover:opacity-100",
                  dragging && "opacity-100"
                )}
              />
              <div className="relative z-1 flex h-5 w-0.75 flex-col items-center justify-center gap-0.75 bg-background-dimmed transition-opacity group-hover:opacity-0">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-[0.1875rem] w-0.75 rounded-full bg-surface-control"
                  />
                ))}
              </div>
            </div>
          </>
        )}
        {/* One slot for both layouts, so switching between them doesn't remount the iframe and
            lose the page the reader reached inside it. */}
        {panel && (
          <div
            className={
              overlay
                ? "absolute inset-y-0 right-0 z-30 border-l border-grid-bright shadow-2xl"
                : "h-full shrink-0 overflow-hidden"
            }
            style={
              overlay
                ? { width: `min(${PANEL_WIDTH}px, 100%)` }
                : { width, maxWidth: `calc(100% - ${PAGE_MIN_WIDTH}px)` }
            }
          >
            {panel}
          </div>
        )}
      </div>
    </DocsPanelContext.Provider>
  );
}
