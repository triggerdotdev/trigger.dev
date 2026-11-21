import { ViewColumnsIcon } from "@heroicons/react/20/solid";
import { useLocation, useNavigation } from "@remix-run/react";
import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCopy } from "~/hooks/useCopy";
import { useDimensions } from "~/hooks/useDimensions";
import { useSearchParams } from "~/hooks/useSearchParam";
import { cn } from "~/utils/cn";
import { Button } from "../Buttons";
import { Icon, type RenderIcon } from "../Icon";
import { Popover, PopoverContent, PopoverEllipseTrigger } from "../Popover";
import * as Property from "../PropertyTable";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../Resizable";
import { Sheet, SheetContent, SheetTitle } from "../SheetV3";
import { TabButton, TabContainer } from "../Tabs";
import { SimpleTooltip } from "../Tooltip";
import { TruncatedText } from "../TruncatedText";
import { PageTitle } from "../PageHeader";

/*
 * The detail page template: a header that owns identity and actions, tabs under it, a main
 * column for the selected tab, and a property rail. An entity fills the slots; it doesn't build
 * a layout. Below NARROW_WIDTH of page width the rail closes and a Details button in the tab bar
 * opens it as a sheet, and the header's secondary actions move into a more menu.
 */

// Page width without the side menu. The rail stays on a 1280px window and closes at ~820px;
// the header folds its secondary actions earlier, since they need more room than the rail.
const NARROW_WIDTH = 900;
const COMPACT_HEADER_WIDTH = 1100;

type DetailPageContextValue = { narrow: boolean; compactHeader: boolean; openRail: () => void };
const DetailPageContext = createContext<DetailPageContextValue>({
  narrow: false,
  compactHeader: false,
  openRail: () => {},
});

export function DetailPage({
  id,
  header,
  tabs,
  rail,
  children,
  className,
}: {
  /** Prefix for the resizable panel ids, so each entity remembers its own rail width. */
  id: string;
  header: ReactNode;
  tabs?: ReactNode;
  rail?: ReactNode;
  /** The selected tab's content. */
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dimensions = useDimensions(ref);
  const narrow = dimensions ? dimensions.width < NARROW_WIDTH : false;
  const compactHeader = dimensions ? dimensions.width < COMPACT_HEADER_WIDTH : false;
  const [railOpen, setRailOpen] = useState(false);
  const hasRail = rail !== undefined;
  const context = useMemo(
    () => ({ narrow: narrow && hasRail, compactHeader, openRail: () => setRailOpen(true) }),
    [narrow, hasRail, compactHeader]
  );

  return (
    <DetailPageContext.Provider value={context}>
      <div
        ref={ref}
        className={cn(
          // One column that can shrink: a long header line truncates rather than widening the page.
          "grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden bg-background-dimmed",
          className
        )}
      >
        {header}
        {tabs ?? <div className="h-px bg-grid-bright" />}
        {rail === undefined || narrow ? (
          <div className="min-h-0 overflow-hidden">{children}</div>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="h-full max-h-full">
            <ResizablePanel id={`${id}-main`} min="300px">
              <div className="h-full min-h-0 overflow-hidden">{children}</div>
            </ResizablePanel>
            <ResizableHandle id={`${id}-rail-handle`} />
            <ResizablePanel
              id={`${id}-rail`}
              min="280px"
              default="320px"
              max="400px"
              isStaticAtRest
            >
              {rail}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
      {rail !== undefined && narrow ? (
        <Sheet open={railOpen} onOpenChange={setRailOpen}>
          <SheetContent className="flex w-[320px] max-w-[85vw] flex-col gap-0 bg-background-bright p-0 sm:max-w-[320px]">
            <SheetTitle className="h-10 flex-none bg-background-bright py-0 text-sm font-medium text-text-bright">
              Details
            </SheetTitle>
            <div className="min-h-0 flex-1">{rail}</div>
          </SheetContent>
        </Sheet>
      ) : null}
    </DetailPageContext.Provider>
  );
}

function useDetailPage() {
  return useContext(DetailPageContext);
}

/** A scrolling main column with the template's padding and section gap. */
export function DetailMain({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-6 overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
        className
      )}
    >
      {children}
    </div>
  );
}

type Crumb = { to: string; text: string };

/**
 * The NavBar title of a detail page: the crumbs that lead to it, then the title as a plain crumb
 * in the same type, so it doesn't repeat the DetailHeader's bold title right below it. Pass
 * `backButton` for one parent, or `crumbs` for a nested page (outermost first, e.g. Tasks, then
 * the task).
 */
export function DetailPageTitle({
  title,
  ...trail
}: { title: string } & (
  | { backButton: Crumb; crumbs?: never }
  | { crumbs: Crumb[]; backButton?: never }
)) {
  const crumbs = trail.crumbs ?? [trail.backButton];
  return (
    <PageTitle
      backButton={crumbs[crumbs.length - 1]}
      parentCrumbs={crumbs.slice(0, -1)}
      favoriteTitle={title}
      title={
        <span className="min-w-0 truncate text-xs font-normal leading-4 tracking-normal text-text-dimmed">
          {title}
        </span>
      }
    />
  );
}

export function DetailHeader({
  icon,
  iconClassName,
  title,
  mono = false,
  badges,
  status,
  meta = [],
  friendlyId,
  secondaryActions,
  primaryAction,
}: {
  icon: RenderIcon;
  /** The entity colour, e.g. `text-bulkActions`. */
  iconClassName?: string;
  title: string;
  /** For identifiers: task ids, endpoint slugs. */
  mono?: boolean;
  badges?: ReactNode;
  /** One of the existing status components. */
  status?: ReactNode;
  /** Up to three short facts, separated by dots. */
  meta?: ReactNode[];
  friendlyId?: string;
  /** Rendered left of the primary action; moves into a more menu at narrow widths. */
  secondaryActions?: ReactNode;
  primaryAction?: ReactNode;
}) {
  const { compactHeader: narrow } = useDetailPage();

  const metaItems = meta.slice(0, 3);

  const titleRow = (
    <div className="flex min-w-0 items-center gap-2.5">
      <TruncatedText
        text={title}
        className={cn(
          "min-w-0 text-text-bright",
          mono
            ? "font-mono text-[1.0625rem] font-medium leading-6"
            : "text-lg font-semibold leading-6 tracking-tight"
        )}
      />
      {friendlyId ? <IdCopy value={friendlyId} /> : null}
      {badges ? <div className="flex flex-none items-center gap-1.5">{badges}</div> : null}
      {status ? <div className="flex flex-none items-center text-sm">{status}</div> : null}
    </div>
  );

  const metaRow =
    metaItems.length > 0 ? (
      <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-text-dimmed">
        {metaItems.map((item, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <span className="size-[3px] flex-none rounded-full bg-surface-control-hover" />
            ) : null}
            {/* Only an item that truncates gives way when the line runs out of room. */}
            <span className="flex shrink-0 items-center gap-1 has-[.truncate]:min-w-0 has-[.truncate]:shrink">
              {item}
            </span>
          </Fragment>
        ))}
      </div>
    ) : null;

  const actions = (
    <div className="flex flex-none items-center gap-2">
      {secondaryActions ? (
        narrow ? (
          <Popover>
            <PopoverEllipseTrigger
              variant="secondary"
              orientation="horizontal"
              aria-label="More actions"
            />
            <PopoverContent align="end" className="flex flex-col items-stretch gap-1 p-1">
              {secondaryActions}
            </PopoverContent>
          </Popover>
        ) : (
          secondaryActions
        )
      ) : null}
      {primaryAction}
    </div>
  );

  // Icon as tall as the title and facts beside it (46px); actions on the facts' line; a rule
  // separates the header from the tabs.
  return (
    <div className="flex items-end gap-4 border-b border-grid-bright bg-background-bright px-4 pb-3 pt-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="grid size-[46px] flex-none place-items-center rounded-md bg-background-hover">
          <Icon icon={icon} className={cn("size-5", iconClassName)} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          {titleRow}
          {metaRow}
        </div>
      </div>
      {actions}
    </div>
  );
}

/** Click to copy; the tooltip shows the full id. */
function IdCopy({ value }: { value: string }) {
  const { copy, copied } = useCopy(value);
  return (
    <SimpleTooltip
      asChild
      tabbable
      disableHoverableContent
      button={
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ID ${value}`}
          className={cn(
            "flex flex-none items-center gap-1 rounded transition-colors focus-custom",
            "size-6 justify-center text-text-faint hover:bg-background-hover hover:text-text-bright",
            copied && "text-success hover:text-success"
          )}
        >
          {copied ? (
            <ClipboardCheckIcon className={"size-3.5"} />
          ) : (
            <ClipboardIcon className={"size-3.5"} />
          )}
        </button>
      }
      content={
        <span className="flex flex-col gap-0.5">
          <span className="font-mono text-xs text-text-bright">{value}</span>
          <span className="text-[0.6875rem] text-text-dimmed">
            {copied ? "Copied" : "Click to copy"}
          </span>
        </span>
      }
    />
  );
}

export type DetailTab<T extends string = string> = {
  id: T;
  label: string;
  /** Only when it's cheap to get. */
  count?: ReactNode;
};

export function DetailTabs<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  tools,
  layoutId = "detail-tabs",
}: {
  tabs: DetailTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  /** Right-aligned, e.g. a time period filter. */
  tools?: ReactNode;
  layoutId?: string;
}) {
  const { narrow, openRail } = useDetailPage();

  return (
    <TabContainer variant="title" className="gap-x-3 bg-background-bright px-4">
      <div className="flex min-w-0 flex-1 items-stretch gap-x-5 overflow-x-auto scrollbar-none">
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            isActive={tab.id === activeTab}
            layoutId={layoutId}
            variant="title"
            size="small"
            className="flex-none whitespace-nowrap"
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className="ml-1.5 text-[0.6875rem] tabular-nums text-text-faint">
                {tab.count}
              </span>
            ) : null}
          </TabButton>
        ))}
      </div>
      {tools || narrow ? (
        <div className="flex flex-none items-center gap-1.5">
          {tools}
          {narrow ? (
            <Button variant="secondary/small" LeadingIcon={ViewColumnsIcon} onClick={openRail}>
              Details
            </Button>
          ) : null}
        </div>
      ) : null}
    </TabContainer>
  );
}

/** The active tab, kept in `?tab=`. The first id is the default and leaves the URL clean. */
export function useDetailTab<T extends string>(ids: readonly T[]) {
  const { replace } = useSearchParams();
  const location = useLocation();
  const navigation = useNavigation();
  const pick = (raw: string | null | undefined) => ids.find((id) => id === raw) ?? ids[0];
  const committed = pick(new URLSearchParams(location.search).get("tab"));
  // Follow a pending navigation only while it stays on this page, so the tab being opened shows
  // as soon as it's clicked; leaving the page (e.g. a sidebar link) keeps the current tab.
  const pending = navigation.location;
  const tab =
    pending && pending.pathname === location.pathname
      ? pick(new URLSearchParams(pending.search).get("tab"))
      : committed;
  // The loader data on screen still belongs to the committed tab until the navigation lands, and
  // React Router waits for a revalidating route's deferred data, so the page shows the opened
  // tab's skeleton meanwhile instead of the old tab.
  const isPending = tab !== committed;
  const setTab = (next: T, extra?: Record<string, string | undefined>) =>
    replace({ ...extra, tab: next === ids[0] ? undefined : next });
  return [tab, setTab, isPending] as const;
}

/** Read-only property groups. Details comes first, then the entity's own groups. */
export function PropertyRail({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <aside
      className={cn(
        "flex h-full flex-col gap-1.5 overflow-y-auto bg-background-bright pb-4 pt-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
        className
      )}
    >
      {children}
    </aside>
  );
}

export function PropertyGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col px-4 pb-1.5 pt-3">
      <h3 className="mb-[9px] text-[0.6875rem] font-medium uppercase tracking-[0.07em] text-text-faint">
        {title}
      </h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** Groups related properties; one column, like every inspector's Property.Table. */
export function PropertyPair({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-y-3">{children}</div>;
}

/** Label above value. A string value truncates and shows in full on hover. */
export function DetailProperty({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Property.Item className="min-w-0">
      <Property.Label>{label}</Property.Label>
      <Property.Value className="flex min-w-0 items-center gap-1.5">
        {typeof children === "string" ? <TruncatedText text={children} /> : children}
      </Property.Value>
    </Property.Item>
  );
}
