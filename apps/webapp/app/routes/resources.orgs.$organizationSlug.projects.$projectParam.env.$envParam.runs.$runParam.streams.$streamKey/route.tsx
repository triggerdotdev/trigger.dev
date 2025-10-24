import { type SSEStreamPart, SSEStreamSubscription } from "@trigger.dev/core/v3";
import {
  BoltIcon,
  BoltSlashIcon,
  ListBulletIcon,
  Bars3BottomLeftIcon,
} from "@heroicons/react/20/solid";
import { Clipboard, ClipboardCheck } from "lucide-react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import simplur from "simplur";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3RunStreamParamsSchema } from "~/utils/pathBuilder";

type ViewMode = "list" | "compact";

type StreamChunk = {
  id: string;
  data: unknown;
  timestamp: number;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam, runParam, streamKey } =
    v3RunStreamParamsSchema.parse(params);

  const project = await $replica.project.findFirst({
    where: {
      slug: projectParam,
      organization: {
        slug: organizationSlug,
        members: {
          some: {
            userId,
          },
        },
      },
    },
  });

  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const run = await $replica.taskRun.findFirst({
    where: {
      friendlyId: runParam,
      projectId: project.id,
    },
    include: {
      runtimeEnvironment: {
        include: {
          project: true,
          organization: true,
          orgMember: true,
        },
      },
    },
  });

  if (!run) {
    throw new Response("Not Found", { status: 404 });
  }

  if (run.runtimeEnvironment.slug !== envParam) {
    throw new Response("Not Found", { status: 404 });
  }

  // Get Last-Event-ID header for resuming from a specific position
  const lastEventId = request.headers.get("Last-Event-ID") || undefined;

  const realtimeStream = getRealtimeStreamInstance(
    run.runtimeEnvironment,
    run.realtimeStreamsVersion
  );

  return realtimeStream.streamResponse(request, run.friendlyId, streamKey, request.signal, {
    lastEventId,
  });
};

export function RealtimeStreamViewer({
  runId,
  streamKey,
  metadata,
}: {
  runId: string;
  streamKey: string;
  metadata: Record<string, unknown> | undefined;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const resourcePath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/${runId}/streams/${streamKey}`;

  const startIndex = typeof metadata?.startIndex === "number" ? metadata.startIndex : undefined;
  const { chunks, error, isConnected } = useRealtimeStream(resourcePath, startIndex);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [mouseOver, setMouseOver] = useState(false);
  const [copied, setCopied] = useState(false);

  const getCompactText = useCallback(() => {
    return chunks
      .map((chunk) => {
        if (typeof chunk.data === "string") {
          return chunk.data;
        }
        return JSON.stringify(chunk.data);
      })
      .join("");
  }, [chunks]);

  const onCopied = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      navigator.clipboard.writeText(getCompactText());
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    },
    [getCompactText]
  );

  // Use IntersectionObserver to detect when the bottom element is visible
  useEffect(() => {
    const bottomElement = bottomRef.current;
    if (!bottomElement) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) {
          setIsAtBottom(entry.isIntersecting);
        }
      },
      {
        root: scrollRef.current,
        threshold: 0.1,
      }
    );

    observer.observe(bottomElement);

    return () => {
      observer.disconnect();
    };
  }, []);

  // Auto-scroll to bottom when new chunks arrive, if we're at the bottom
  useEffect(() => {
    if (isAtBottom && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "instant", block: "end" });
    }
  }, [chunks, isAtBottom]);

  const firstLineNumber = startIndex ?? 0;
  const lastLineNumber = firstLineNumber + chunks.length - 1;
  const maxLineNumberWidth = (chunks.length > 0 ? lastLineNumber : firstLineNumber).toString()
    .length;

  return (
    <div className="flex h-full flex-col overflow-hidden border-t border-grid-bright">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-grid-bright bg-background-bright px-3 py-3">
        <Paragraph variant="small/bright" className="mb-0">
          Stream: <span className="font-mono text-text-dimmed">{streamKey}</span>
        </Paragraph>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-1">
              {isConnected ? (
                <BoltIcon className={cn("size-3.5 animate-pulse text-success")} />
              ) : (
                <BoltSlashIcon className={cn("size-3.5 text-text-dimmed")} />
              )}
              <Paragraph variant="small" className="mb-0">
                {isConnected ? "Connected" : "Disconnected"}
              </Paragraph>
            </div>
            <Paragraph variant="small" className="mb-0">
              {simplur`${chunks.length} chunk[|s]`}
            </Paragraph>
          </div>
          <TooltipProvider>
            <Tooltip disableHoverableContent>
              <TooltipTrigger
                onClick={() => setViewMode(viewMode === "list" ? "compact" : "list")}
                className="text-text-dimmed transition-colors focus-custom hover:cursor-pointer hover:text-text-bright"
              >
                {viewMode === "list" ? (
                  <Bars3BottomLeftIcon className="size-4" />
                ) : (
                  <ListBulletIcon className="size-4" />
                )}
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                {viewMode === "list" ? "Compact view" : "List view"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Content */}
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-y-auto bg-charcoal-900 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
      >
        {chunks.length > 0 && (
          <div className="pointer-events-none sticky top-2.5 z-50 h-0">
            <div className="pointer-events-auto absolute right-3 top-0">
              <TooltipProvider>
                <Tooltip open={copied || mouseOver} disableHoverableContent>
                  <TooltipTrigger
                    onClick={onCopied}
                    onMouseEnter={() => setMouseOver(true)}
                    onMouseLeave={() => setMouseOver(false)}
                    className={cn(
                      "transition-colors duration-100 focus-custom hover:cursor-pointer",
                      copied ? "text-success" : "text-text-dimmed hover:text-text-bright"
                    )}
                  >
                    {copied ? (
                      <ClipboardCheck className="size-4" />
                    ) : (
                      <Clipboard className="size-4" />
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    {copied ? "Copied" : "Copy"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        )}

        {error && (
          <div className="border-b border-error/20 bg-error/10 p-3">
            <Paragraph variant="small" className="mb-0 text-error">
              Error: {error.message}
            </Paragraph>
          </div>
        )}

        {chunks.length === 0 && !error && (
          <div className="flex h-full items-center justify-center">
            <Paragraph variant="small" className="mb-0 text-text-dimmed">
              {isConnected ? "Waiting for data..." : "No data received"}
            </Paragraph>
          </div>
        )}

        {chunks.length > 0 && viewMode === "list" && (
          <div className="p-3 font-mono text-xs leading-relaxed">
            {chunks.map((chunk, index) => (
              <StreamChunkLine
                key={index}
                chunk={chunk}
                lineNumber={firstLineNumber + index}
                maxLineNumberWidth={maxLineNumberWidth}
              />
            ))}
            {/* Sentinel element for IntersectionObserver */}
            <div ref={bottomRef} className="h-px" />
          </div>
        )}

        {chunks.length > 0 && viewMode === "compact" && (
          <div className="p-3 font-mono text-xs leading-relaxed">
            <CompactStreamView chunks={chunks} />
            {/* Sentinel element for IntersectionObserver */}
            <div ref={bottomRef} className="h-px" />
          </div>
        )}
      </div>

      {/* Footer with auto-scroll indicator */}
      {!isAtBottom && chunks.length > 0 && (
        <div className="border-t border-grid-bright bg-charcoal-850 px-3 py-2">
          <button
            onClick={() => {
              bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            }}
            className="text-xs text-blue-500 hover:text-blue-400"
          >
            ↓ Scroll to bottom
          </button>
        </div>
      )}
    </div>
  );
}

function CompactStreamView({ chunks }: { chunks: StreamChunk[] }) {
  const compactText = chunks
    .map((chunk) => {
      if (typeof chunk.data === "string") {
        return chunk.data;
      }
      return JSON.stringify(chunk.data);
    })
    .join("");

  return <div className="whitespace-pre-wrap break-all text-text-bright">{compactText}</div>;
}

function StreamChunkLine({
  chunk,
  lineNumber,
  maxLineNumberWidth,
}: {
  chunk: StreamChunk;
  lineNumber: number;
  maxLineNumberWidth: number;
}) {
  const formattedData =
    typeof chunk.data === "string" ? chunk.data : JSON.stringify(chunk.data, null, 2);

  const date = new Date(chunk.timestamp);
  const timeString = date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const milliseconds = date.getMilliseconds().toString().padStart(3, "0");
  const timestamp = `${timeString}.${milliseconds}`;

  return (
    <div className="group flex w-full gap-3 py-1 hover:bg-charcoal-800">
      {/* Line number */}
      <div
        className="flex-none select-none text-right text-charcoal-500"
        style={{ width: `${Math.max(maxLineNumberWidth, 3)}ch` }}
      >
        {lineNumber}
      </div>

      {/* Timestamp */}
      <div className="flex-none select-none text-charcoal-500">{timestamp}</div>

      {/* Content */}
      <div className="min-w-0 flex-1 break-all text-text-bright">{formattedData}</div>
    </div>
  );
}

function useRealtimeStream(resourcePath: string, startIndex?: number) {
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();
    let reader: ReadableStreamDefaultReader<SSEStreamPart<unknown>> | null = null;

    async function connectAndConsume() {
      try {
        const sseSubscription = new SSEStreamSubscription(resourcePath, {
          signal: abortController.signal,
          lastEventId: startIndex ? (startIndex - 1).toString() : undefined,
          timeoutInSeconds: 30,
        });

        const stream = await sseSubscription.subscribe();
        setIsConnected(true);

        reader = stream.getReader();

        // Read from the stream
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          if (value !== undefined) {
            setChunks((prev) => [
              ...prev,
              {
                id: value.id,
                data: value.chunk,
                timestamp: value.timestamp,
              },
            ]);
          }
        }
      } catch (err) {
        // Only set error if not aborted
        if (!abortController.signal.aborted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        setIsConnected(false);
      }
    }

    connectAndConsume();

    return () => {
      abortController.abort();
      reader?.cancel();
    };
  }, [resourcePath, startIndex]);

  return { chunks, error, isConnected };
}
