import { BoltIcon, BoltSlashIcon } from "@heroicons/react/20/solid";
import { BookOpenIcon, CheckIcon } from "@heroicons/react/24/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Clipboard, ClipboardCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import simplur from "simplur";
import { z } from "zod";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { MessageInputIcon } from "~/assets/icons/MessageInputIcon";
import { MessageOutputIcon } from "~/assets/icons/MessageOutputIcon";
import { MoveToBottomIcon } from "~/assets/icons/MoveToBottomIcon";
import { MoveToTopIcon } from "~/assets/icons/MoveToTopIcon";
import { TextInlineIcon } from "~/assets/icons/TextInlineIcon";
import { TextWrapIcon } from "~/assets/icons/TextWrapIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { PageBody } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { AgentView } from "~/components/runs/v3/agent/AgentView";
import { RunTag } from "~/components/runs/v3/RunTag";
import {
  descriptionForTaskRunStatus,
  TaskRunStatusCombo,
} from "~/components/runs/v3/TaskRunStatus";
import { CloseSessionDialog } from "~/components/sessions/v1/CloseSessionDialog";
import { SessionStatusCombo } from "~/components/sessions/v1/SessionStatus";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useHasAdminAccess } from "~/hooks/useUser";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { SessionPresenter } from "~/presenters/v3/SessionPresenter.server";
import {
  type StreamChunk,
  useRealtimeStream,
} from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.streams.$streamKey/route";
import { requireUserId } from "~/services/session.server";
import { type SessionStatus } from "~/services/sessionsRepository/sessionsRepository.server";
import { cn } from "~/utils/cn";
import { throwNotFound } from "~/utils/httpErrors";
import {
  docsPath,
  EnvironmentParamSchema,
  v3RunPath,
  v3RunsPath,
  v3SessionsPath,
} from "~/utils/pathBuilder";

const ParamsSchema = EnvironmentParamSchema.extend({
  sessionParam: z.string(),
});

export const meta: MetaFunction = () => {
  return [{ title: `Session | Trigger.dev` }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, sessionParam } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return redirectWithErrorMessage("/", request, "Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throwNotFound("Environment not found");
  }

  const presenter = new SessionPresenter($replica);
  const session = await presenter.call({
    userId,
    environmentId: environment.id,
    sessionParam,
    projectExternalRef: project.externalRef,
    environmentSlug: environment.slug,
  });

  if (!session) {
    throw new Response("Session not found", { status: 404 });
  }

  return typedjson({ session });
};

export default function Page() {
  const { session } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const status: SessionStatus =
    session.closedAt != null
      ? "CLOSED"
      : session.expiresAt != null && new Date(session.expiresAt).getTime() < Date.now()
      ? "EXPIRED"
      : "ACTIVE";

  const displayId = session.externalId ?? session.friendlyId;
  const sessionsPath = v3SessionsPath(organization, project, environment);

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{ to: sessionsPath, text: "Sessions" }}
          title={
            <span className="flex items-center gap-1">
              <AIChatIcon className="size-4.5 text-sessions" />
              <CopyableText value={displayId} />
            </span>
          }
        />
        <PageAccessories>
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/ai-chat/sessions")}
          >
            Sessions docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="session-conversation" min={"300px"}>
            <ConversationPane session={session} />
          </ResizablePanel>
          <ResizableHandle id="session-handle" />
          <ResizablePanel
            id="session-inspector"
            min="380px"
            default="420px"
            className="overflow-hidden"
          >
            <InspectorPane session={session} status={status} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </>
  );
}

type LoadedSession = ReturnType<typeof useTypedLoaderData<typeof loader>>["session"];

function ConversationPane({ session }: { session: LoadedSession }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { value, replace } = useSearchParams();
  const isRaw = value("raw") === "1";

  const sessionId = session.agentView.sessionId;
  const encodedSession = encodeURIComponent(sessionId);
  const sessionResourceBase = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/sessions/${encodedSession}/realtime/v1`;

  const setView = useCallback((raw: boolean) => replace({ raw: raw ? "1" : undefined }), [replace]);

  return (
    <div className="flex h-full max-h-full flex-col overflow-hidden bg-background-bright">
      {isRaw ? (
        <RawConversationView
          inResourcePath={`${sessionResourceBase}/in`}
          outResourcePath={`${sessionResourceBase}/out`}
          isRaw={isRaw}
          onChangeView={setView}
        />
      ) : (
        <>
          <ConversationUtilityBar isRaw={isRaw} onChangeView={setView} />
          <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <AgentView agentView={session.agentView} />
          </div>
        </>
      )}
    </div>
  );
}

function ConversationUtilityBar({
  isRaw,
  onChangeView,
  right,
}: {
  isRaw: boolean;
  onChangeView: (raw: boolean) => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex h-9 items-center justify-between gap-3 border-b border-grid-bright px-3">
      <TabContainer className="-mb-2">
        <TabButton
          isActive={!isRaw}
          layoutId="conversation-view-mode"
          onClick={() => onChangeView(false)}
        >
          Rendered
        </TabButton>
        <TabButton
          isActive={isRaw}
          layoutId="conversation-view-mode"
          onClick={() => onChangeView(true)}
        >
          Raw
        </TabButton>
      </TabContainer>
      {right}
    </div>
  );
}

type MergedChunk = StreamChunk & { source: "in" | "out" };

function formatInlineData(data: unknown): string {
  if (typeof data === "string") return data;
  const json = JSON.stringify(data);
  return json ?? String(data);
}

function formatWrappedData(data: unknown): string {
  if (typeof data === "string") return data;
  const json = JSON.stringify(data, null, 2);
  return json ?? String(data);
}

const ROW_NUMBER_COL_MIN_CH = 3;
const TIME_COL_WIDTH = "7rem";
const TYPE_COL_WIDTH = "5rem";

function RawConversationView({
  inResourcePath,
  outResourcePath,
  isRaw,
  onChangeView,
}: {
  inResourcePath: string;
  outResourcePath: string;
  isRaw: boolean;
  onChangeView: (raw: boolean) => void;
}) {
  const {
    chunks: inChunks,
    error: inError,
    isConnected: inConnected,
  } = useRealtimeStream(inResourcePath);
  const {
    chunks: outChunks,
    error: outError,
    isConnected: outConnected,
  } = useRealtimeStream(outResourcePath);

  const merged = useMemo<MergedChunk[]>(() => {
    const all: MergedChunk[] = [
      ...inChunks.map((c) => ({ ...c, source: "in" as const })),
      ...outChunks.map((c) => ({ ...c, source: "out" as const })),
    ];
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }, [inChunks, outChunks]);

  const longestInlineMessage = useMemo(() => {
    let longest = "";
    for (const chunk of merged) {
      const text = formatInlineData(chunk.data);
      if (text.length > longest.length) longest = text;
    }
    return longest;
  }, [merged]);

  const error = inError ?? outError;
  const isConnected = inConnected || outConnected;
  const totalChunks = merged.length;

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [copied, setCopied] = useState(false);
  const [mouseOver, setMouseOver] = useState(false);
  const [isWrapped, setIsWrapped] = useState(false);

  const getCompactText = useCallback(() => {
    return merged
      .map((chunk) => {
        const prefix = chunk.source === "in" ? "» " : "« ";
        return `${prefix}${formatInlineData(chunk.data)}`;
      })
      .join("\n");
  }, [merged]);

  const onCopied = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      navigator.clipboard.writeText(getCompactText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [getCompactText]
  );

  // Observer + scroll listener attach once on mount. Earlier this effect
  // depended on `merged.length` and tore down / re-attached on every
  // streaming chunk, thrashing CPU on hot sessions.
  useEffect(() => {
    const bottomElement = bottomRef.current;
    const scrollElement = scrollRef.current;
    if (!bottomElement || !scrollElement) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setIsAtBottom(entry.isIntersecting);
      },
      { root: scrollElement, threshold: 0.1, rootMargin: "0px" }
    );
    observer.observe(bottomElement);

    let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const scrollBottom = scrollElement.scrollTop + scrollElement.clientHeight;
        setIsAtBottom(scrollElement.scrollHeight - scrollBottom < 50);
      }, 100);
    };
    scrollElement.addEventListener("scroll", handleScroll);

    // Initial state — match the post-mount scroll position.
    const initialScrollBottom = scrollElement.scrollTop + scrollElement.clientHeight;
    setIsAtBottom(scrollElement.scrollHeight - initialScrollBottom < 50);

    return () => {
      observer.disconnect();
      scrollElement.removeEventListener("scroll", handleScroll);
      if (scrollTimeout) clearTimeout(scrollTimeout);
    };
  }, []);

  // Stick-to-bottom on new content. Defer the scroll write to the next
  // animation frame so the virtualizer's layout effect has run and
  // `scrollHeight` reflects the updated content. Without rAF, the write
  // races the virtualizer's `getTotalSize()` update and the user gets
  // "stuck half a row up" while streaming.
  useEffect(() => {
    if (!isAtBottom || !scrollRef.current) return;
    const el = scrollRef.current;
    const raf = requestAnimationFrame(() => {
      const currentScrollLeft = el.scrollLeft;
      el.scrollTop = el.scrollHeight;
      el.scrollLeft = currentScrollLeft;
    });
    return () => cancelAnimationFrame(raf);
  }, [merged, isAtBottom]);

  const rowVirtualizer = useVirtualizer({
    count: merged.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 8,
  });

  const rowNumberWidthCh = Math.max(ROW_NUMBER_COL_MIN_CH, merged.length.toString().length);

  const controls = (
    <div className="flex items-center gap-3">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            {isConnected ? (
              <BoltIcon className="size-3.5 animate-pulse cursor-default text-success" />
            ) : (
              <BoltSlashIcon className="size-3.5 cursor-default text-text-dimmed" />
            )}
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {isConnected ? "Connected" : "Disconnected"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Paragraph variant="small" className="mb-0 whitespace-nowrap">
        {simplur`${totalChunks} chunk[|s]`}
      </Paragraph>
      <TooltipProvider>
        <Tooltip
          open={totalChunks === 0 ? false : copied || mouseOver || undefined}
          disableHoverableContent
        >
          <TooltipTrigger
            disabled={totalChunks === 0}
            onClick={onCopied}
            onMouseEnter={() => setMouseOver(true)}
            onMouseLeave={() => setMouseOver(false)}
            className={cn(
              "transition-colors duration-100 focus-custom",
              totalChunks === 0
                ? "cursor-not-allowed opacity-50"
                : copied
                ? "text-success hover:cursor-pointer"
                : "text-text-dimmed hover:cursor-pointer hover:text-text-bright"
            )}
          >
            {copied ? <ClipboardCheck className="size-4" /> : <Clipboard className="size-4" />}
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {copied ? "Copied" : "Copy"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip disableHoverableContent>
          <TooltipTrigger
            onClick={() => setIsWrapped((w) => !w)}
            className="text-text-dimmed transition-colors focus-custom hover:cursor-pointer hover:text-text-bright"
          >
            {isWrapped ? (
              <TextInlineIcon className="size-4" />
            ) : (
              <TextWrapIcon className="size-4" />
            )}
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {isWrapped ? "Show messages on one line" : "Wrap messages"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip open={totalChunks === 0 ? false : undefined} disableHoverableContent>
          <TooltipTrigger
            disabled={totalChunks === 0}
            onClick={() => {
              if (isAtBottom) {
                scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
              } else {
                bottomRef.current?.scrollIntoView({
                  behavior: "smooth",
                  block: "end",
                  inline: "nearest",
                });
              }
            }}
            className={cn(
              "text-text-dimmed transition-colors focus-custom",
              totalChunks === 0
                ? "cursor-not-allowed opacity-50"
                : "hover:cursor-pointer hover:text-text-bright"
            )}
          >
            {isAtBottom ? (
              <MoveToTopIcon className="size-4" />
            ) : (
              <MoveToBottomIcon className="size-4" />
            )}
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {isAtBottom ? "Scroll to top" : "Scroll to bottom"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );

  return (
    <>
      <ConversationUtilityBar isRaw={isRaw} onChangeView={onChangeView} right={controls} />
      <div className="flex min-h-0 flex-1 flex-col bg-charcoal-900">
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <div
            className="font-mono text-xs leading-tight"
            style={{ width: isWrapped ? "100%" : "max-content", minWidth: "100%" }}
          >
            <StreamColumnHeader
              rowNumberWidthCh={rowNumberWidthCh}
              timeColWidth={TIME_COL_WIDTH}
              typeColWidth={TYPE_COL_WIDTH}
              className="sticky top-0 z-10"
            />

            {error && (
              <div className="border-b border-error/20 bg-error/10 p-3">
                <Paragraph variant="small" className="mb-0 text-error">
                  Error: {error.message}
                </Paragraph>
              </div>
            )}

            {merged.length === 0 && !error && (
              <div className="flex h-full items-center justify-center py-6">
                {isConnected ? (
                  <div className="flex items-center gap-2">
                    <Spinner />
                    <Paragraph variant="small" className="mb-0 text-text-dimmed">
                      Waiting for data…
                    </Paragraph>
                  </div>
                ) : (
                  <Paragraph variant="small" className="mb-0 text-text-dimmed">
                    No data received
                  </Paragraph>
                )}
              </div>
            )}

            {merged.length > 0 && (
              <>
                {!isWrapped && longestInlineMessage && (
                  <div
                    aria-hidden
                    className="invisible flex"
                    style={{ height: 0, overflow: "hidden" }}
                  >
                    <div className="flex-none" style={{ width: `${rowNumberWidthCh}ch` }} />
                    <div className="flex-none px-3" style={{ width: TIME_COL_WIDTH }} />
                    <div className="flex-none px-3" style={{ width: TYPE_COL_WIDTH }} />
                    <div className="whitespace-nowrap px-3">{longestInlineMessage}</div>
                  </div>
                )}
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    position: "relative",
                    minWidth: "100%",
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                    const chunk = merged[virtualItem.index];
                    return (
                      <MergedStreamRow
                        key={virtualItem.key}
                        chunk={chunk}
                        lineNumber={virtualItem.index + 1}
                        rowNumberWidthCh={rowNumberWidthCh}
                        timeColWidth={TIME_COL_WIDTH}
                        typeColWidth={TYPE_COL_WIDTH}
                        isWrapped={isWrapped}
                        start={virtualItem.start}
                        measure={(el) => rowVirtualizer.measureElement(el)}
                        index={virtualItem.index}
                      />
                    );
                  })}
                  <div
                    ref={bottomRef}
                    className="h-px"
                    style={{
                      position: "absolute",
                      top: `${rowVirtualizer.getTotalSize()}px`,
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function StreamColumnHeader({
  rowNumberWidthCh,
  timeColWidth,
  typeColWidth,
  className,
}: {
  rowNumberWidthCh: number;
  timeColWidth: string;
  typeColWidth: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex h-9 select-none items-center bg-charcoal-900 font-sans text-sm font-medium leading-normal text-text-bright after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright",
        className
      )}
    >
      <div className="flex-none" style={{ width: `${rowNumberWidthCh}ch` }} />
      <div className="flex-none px-3" style={{ width: timeColWidth }}>
        Time
      </div>
      <div className="flex-none px-3" style={{ width: typeColWidth }}>
        Type
      </div>
      <div className="min-w-0 flex-1 px-3">Message</div>
    </div>
  );
}

function MergedStreamRow({
  chunk,
  lineNumber,
  rowNumberWidthCh,
  timeColWidth,
  typeColWidth,
  isWrapped,
  start,
  measure,
  index,
}: {
  chunk: MergedChunk;
  lineNumber: number;
  rowNumberWidthCh: number;
  timeColWidth: string;
  typeColWidth: string;
  isWrapped: boolean;
  start: number;
  measure: (el: HTMLDivElement | null) => void;
  index: number;
}) {
  const wrappedData = formatWrappedData(chunk.data);
  const inlineData = formatInlineData(chunk.data);

  const date = new Date(chunk.timestamp);
  const timeString = date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
  const timestamp = `${timeString}.${milliseconds}`;

  const isInput = chunk.source === "in";

  return (
    <div
      ref={measure}
      data-index={index}
      className="group flex items-start py-1 hover:bg-charcoal-800"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        transform: `translateY(${start}px)`,
      }}
    >
      <div
        className="flex-none select-none pl-2 text-right text-charcoal-500"
        style={{ width: `${rowNumberWidthCh}ch` }}
      >
        {lineNumber}
      </div>
      <div className="flex-none select-none pl-3 text-charcoal-500" style={{ width: timeColWidth }}>
        {timestamp}
      </div>
      <div className="flex-none px-3" style={{ width: typeColWidth }}>
        <span
          className={cn(
            "inline-flex items-center gap-1",
            isInput ? "text-success" : "text-blue-500"
          )}
        >
          {isInput ? (
            <MessageInputIcon className="size-3.5" />
          ) : (
            <MessageOutputIcon className="size-3.5" />
          )}
          {isInput ? "Input" : "Output"}
        </span>
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 px-3 text-text-bright",
          isWrapped ? "whitespace-pre-wrap break-words" : "whitespace-nowrap"
        )}
      >
        {isWrapped ? wrappedData : inlineData}
      </div>
    </div>
  );
}

function InspectorPane({ session, status }: { session: LoadedSession; status: SessionStatus }) {
  const { value, replace } = useSearchParams();
  const tab = value("tab") ?? "overview";
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const displayId = session.externalId ?? session.friendlyId;
  const allRunsPath = v3RunsPath(organization, project, environment, {
    tags: [`chat:${displayId}`],
  });

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden px-3">
        <div className="flex items-center gap-2 overflow-x-hidden">
          <span className="truncate font-mono text-sm text-text-dimmed">{session.friendlyId}</span>
        </div>
      </div>
      <div className="h-fit overflow-x-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <TabContainer>
          <TabButton
            isActive={tab === "overview"}
            layoutId="session-inspector"
            onClick={() => replace({ tab: "overview" })}
            shortcut={{ key: "o" }}
          >
            Overview
          </TabButton>
          <TabButton
            isActive={tab === "runs"}
            layoutId="session-inspector"
            onClick={() => replace({ tab: "runs" })}
            shortcut={{ key: "r" }}
          >
            Runs
          </TabButton>
          <TabButton
            isActive={tab === "metadata"}
            layoutId="session-inspector"
            onClick={() => replace({ tab: "metadata" })}
            shortcut={{ key: "m" }}
          >
            Metadata
          </TabButton>
        </TabContainer>
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {tab === "overview" ? (
          <OverviewTab session={session} status={status} />
        ) : tab === "runs" ? (
          <RunsTab session={session} status={status} allRunsPath={allRunsPath} />
        ) : (
          <MetadataTab session={session} />
        )}
      </div>
    </div>
  );
}

function OverviewTab({ session, status }: { session: LoadedSession; status: SessionStatus }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const isAdmin = useHasAdminAccess();
  const sessionsPath = v3SessionsPath(organization, project, environment);

  return (
    <div className="flex flex-col gap-4">
      <Property.Table>
        <div className="flex items-start justify-between gap-3">
          <Property.Item>
            <Property.Label>Status</Property.Label>
            <Property.Value>
              <SessionStatusCombo status={status} />
            </Property.Value>
          </Property.Item>
          {status === "ACTIVE" && (
            <Dialog key={`close-${session.friendlyId}`}>
              <DialogTrigger asChild>
                <Button variant="danger/small">Close session…</Button>
              </DialogTrigger>
              <CloseSessionDialog
                sessionParam={session.friendlyId}
                environmentId={environment.id}
                redirectPath={`${sessionsPath}/${session.friendlyId}`}
              />
            </Dialog>
          )}
        </div>
        <Property.Item>
          <Property.Label>Friendly ID</Property.Label>
          <Property.Value>
            <CopyableText value={session.friendlyId} className="font-mono text-sm" />
          </Property.Value>
        </Property.Item>
        {session.externalId ? (
          <Property.Item>
            <Property.Label>External ID</Property.Label>
            <Property.Value>
              <CopyableText value={session.externalId} className="font-mono text-sm" />
            </Property.Value>
          </Property.Item>
        ) : null}
        <Property.Item>
          <Property.Label>Type</Property.Label>
          <Property.Value>
            <span className="font-mono text-sm">{session.type}</span>
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Agent ID</Property.Label>
          <Property.Value>
            <span className="font-mono text-sm">{session.taskIdentifier}</span>
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Test</Property.Label>
          <Property.Value>
            <span className="sr-only">{session.isTest ? "Yes" : "No"}</span>
            {session.isTest ? (
              <CheckIcon aria-hidden className="size-4 text-text-dimmed" />
            ) : (
              <span aria-hidden className="text-text-dimmed">
                –
              </span>
            )}
          </Property.Value>
        </Property.Item>
        {session.currentRun ? (
          <Property.Item>
            <Property.Label>Current run</Property.Label>
            <Property.Value>
              <span className="flex flex-col gap-0.5">
                <TextLink
                  to={v3RunPath(organization, project, environment, {
                    friendlyId: session.currentRun.friendlyId,
                  })}
                  className="font-mono text-sm"
                >
                  {session.currentRun.friendlyId}
                </TextLink>
                <SimpleTooltip
                  button={<TaskRunStatusCombo status={session.currentRun.status} />}
                  content={descriptionForTaskRunStatus(session.currentRun.status)}
                  disableHoverableContent
                  buttonClassName="w-fit"
                />
              </span>
            </Property.Value>
          </Property.Item>
        ) : null}
        <Property.Item>
          <Property.Label>Tags</Property.Label>
          <Property.Value>
            {session.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {session.tags.map((tag) => (
                  <RunTag key={tag} tag={tag} />
                ))}
              </div>
            ) : (
              <span className="text-text-dimmed">–</span>
            )}
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Created</Property.Label>
          <Property.Value>
            <DateTime date={session.createdAt} />
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Updated</Property.Label>
          <Property.Value>
            <DateTime date={session.updatedAt} />
          </Property.Value>
        </Property.Item>
        {session.expiresAt ? (
          <Property.Item>
            <Property.Label>
              {new Date(session.expiresAt).getTime() < Date.now() ? "Expired" : "Expires"}
            </Property.Label>
            <Property.Value>
              <DateTime date={session.expiresAt} />
            </Property.Value>
          </Property.Item>
        ) : null}
        {session.closedAt ? (
          <Property.Item>
            <Property.Label>Closed</Property.Label>
            <Property.Value>
              <DateTime date={session.closedAt} />
            </Property.Value>
          </Property.Item>
        ) : null}
        {session.closedReason ? (
          <Property.Item>
            <Property.Label>Close reason</Property.Label>
            <Property.Value>
              <span className="text-xs">{session.closedReason}</span>
            </Property.Value>
          </Property.Item>
        ) : null}
      </Property.Table>
      <CodeBlock
        code={JSON.stringify(session.triggerConfig, null, 2)}
        language="json"
        rowTitle="Trigger config"
        maxLines={20}
        showLineNumbers={false}
        showTextWrapping
      />
      {isAdmin && (
        <div className="border-t border-yellow-500/50 pt-2">
          <Paragraph spacing variant="small" className="text-yellow-500">
            Admin only
          </Paragraph>
          <Property.Table>
            <Property.Item>
              <Property.Label>Session ID</Property.Label>
              <Property.Value>
                <span className="font-mono text-xs">{session.id}</span>
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Stream basin</Property.Label>
              <Property.Value>
                <span className="font-mono text-xs">{session.streamBasinName ?? "(global)"}</span>
              </Property.Value>
            </Property.Item>
          </Property.Table>
        </div>
      )}
    </div>
  );
}

function MetadataTab({ session }: { session: LoadedSession }) {
  if (session.metadata == null) {
    return <Paragraph variant="small/dimmed">No metadata.</Paragraph>;
  }
  const json = JSON.stringify(session.metadata, null, 2);
  return <CodeBlock code={json} language="json" showLineNumbers={false} showTextWrapping />;
}

function RunsTab({
  session,
  status,
  allRunsPath,
}: {
  session: LoadedSession;
  status: SessionStatus;
  allRunsPath: string;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  if (session.runs.length === 0) {
    return <Paragraph variant="small/dimmed">No runs yet.</Paragraph>;
  }

  return (
    <div className="flex flex-col">
      <TimelineRow lineVariant="dashed">
        <span className="flex items-center gap-1.5 text-sm font-medium text-text-bright">
          <span>Session:</span>
          <SessionStatusCombo status={status} className="text-sm" />
        </span>
        <span className="text-xs text-text-dimmed">{sessionStatusBlurb(status)}</span>
        <LinkButton variant="secondary/small" to={allRunsPath} className="mt-1 w-fit">
          View all runs
        </LinkButton>
      </TimelineRow>
      {session.runs.map((entry, idx) => {
        const isLast = idx === session.runs.length - 1;
        const runPath = entry.run
          ? v3RunPath(organization, project, environment, {
              friendlyId: entry.run.friendlyId,
            })
          : undefined;
        return (
          <TimelineRow key={entry.id} isLast={isLast}>
            <span className="text-sm font-medium text-text-bright">
              <span className="capitalize">{entry.reason}</span> run
            </span>
            <span className="text-xs text-text-dimmed">
              <DateTime date={entry.triggeredAt} />
            </span>
            {entry.run && runPath ? (
              <>
                <SimpleTooltip
                  asChild
                  buttonClassName="w-fit self-start"
                  button={
                    <TextLink to={runPath} className="font-mono text-sm">
                      <CopyableText
                        value={entry.run.friendlyId}
                        copyValue={entry.run.friendlyId}
                        asChild
                      />
                    </TextLink>
                  }
                  content="Jump to run"
                  disableHoverableContent
                />
                <TaskRunStatusCombo status={entry.run.status} className="text-sm" />
              </>
            ) : (
              <span className="text-text-dimmed">–</span>
            )}
          </TimelineRow>
        );
      })}
    </div>
  );
}

function sessionStatusBlurb(status: SessionStatus): string {
  switch (status) {
    case "ACTIVE":
      return "Accepting new runs";
    case "CLOSED":
      return "No longer accepting new runs";
    case "EXPIRED":
      return "Expired without being closed";
  }
}

function TimelineRow({
  children,
  isLast,
  lineVariant = "solid",
}: {
  children: React.ReactNode;
  isLast?: boolean;
  lineVariant?: "solid" | "dashed";
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-none flex-col items-center">
        <div className="my-1.5 size-2.5 shrink-0 rounded-full border border-charcoal-500" />
        {!isLast &&
          (lineVariant === "dashed" ? (
            <div className="flex-1 border-l border-dashed border-charcoal-600" />
          ) : (
            <div className="w-px flex-1 bg-charcoal-600" />
          ))}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !isLast && "pb-4")}>
        {children}
      </div>
    </div>
  );
}
