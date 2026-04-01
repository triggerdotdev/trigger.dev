import {
  ArrowUpIcon,
  BoltIcon,
  CpuChipIcon,
  StopIcon,
  ArrowPathIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/node";
import { Link, useFetcher, useNavigate, useRouteLoaderData } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { TriggerChatTransport } from "@trigger.dev/sdk/chat";
import type { TriggerChatTaskParams, TriggerChatTaskResult } from "@trigger.dev/sdk/chat";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyButton } from "~/components/primitives/CopyButton";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { ClockRotateLeftIcon } from "~/assets/icons/ClockRotateLeftIcon";
import type { PlaygroundConversation } from "~/presenters/v3/PlaygroundPresenter.server";
import { DateTime } from "~/components/primitives/DateTime";
import { cn } from "~/utils/cn";
import { JSONEditor } from "~/components/code/JSONEditor";
import { ToolUseRow, AssistantResponse, ChatBubble } from "~/components/runs/v3/ai/AIChatMessages";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { playgroundPresenter } from "~/presenters/v3/PlaygroundPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Select, SelectItem } from "~/components/primitives/Select";
import { EnvironmentParamSchema, v3PlaygroundAgentPath } from "~/utils/pathBuilder";
import { env as serverEnv } from "~/env.server";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import { extractJwtSigningSecretKey } from "~/services/realtime/jwtAuth.server";
import { SchemaTabContent } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.test.tasks.$taskParam/SchemaTabContent";
import { AIPayloadTabContent } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.test.tasks.$taskParam/AIPayloadTabContent";
import type { UIMessage } from "@ai-sdk/react";

export const meta: MetaFunction = () => {
  return [{ title: "Playground | Trigger.dev" }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const agentSlug = params.agentParam;

  if (!agentSlug) {
    throw new Response(undefined, { status: 404, statusText: "Agent not specified" });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const agent = await playgroundPresenter.getAgent({
    environmentId: environment.id,
    environmentType: environment.type,
    agentSlug,
  });

  if (!agent) {
    throw new Response(undefined, { status: 404, statusText: "Agent not found" });
  }

  const agentConfig = agent.config as { type?: string } | null;
  const apiOrigin = serverEnv.API_ORIGIN || serverEnv.LOGIN_ORIGIN || "http://localhost:3030";

  const recentConversations = await playgroundPresenter.getRecentConversations({
    environmentId: environment.id,
    agentSlug,
    userId,
  });

  // Check for ?conversation= param to resume an existing conversation
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversation");

  let activeConversation: {
    chatId: string;
    runFriendlyId: string | null;
    publicAccessToken: string | null;
    clientData: unknown;
    messages: unknown;
    lastEventId: string | null;
  } | null = null;

  if (conversationId) {
    const conv = recentConversations.find((c) => c.id === conversationId);
    if (conv) {
      let jwt: string | null = null;
      if (conv.isActive && conv.runFriendlyId) {
        jwt = await internal_generateJWT({
          secretKey: extractJwtSigningSecretKey(environment),
          payload: {
            sub: environment.id,
            pub: true,
            scopes: [`read:runs:${conv.runFriendlyId}`, `write:inputStreams:${conv.runFriendlyId}`],
          },
          expirationTime: "1h",
        });
      }

      activeConversation = {
        chatId: conv.chatId,
        runFriendlyId: conv.runFriendlyId,
        publicAccessToken: jwt,
        clientData: conv.clientData,
        messages: conv.messages,
        lastEventId: conv.lastEventId,
      };
    }
  }

  return typedjson({
    agent: {
      slug: agent.slug,
      filePath: agent.filePath,
      type: agentConfig?.type ?? "unknown",
      clientDataSchema: agent.payloadSchema ?? null,
    },
    apiOrigin,
    recentConversations,
    activeConversation,
  });
};

export default function PlaygroundAgentPage() {
  const { activeConversation } = useTypedLoaderData<typeof loader>();
  // Key on conversation chatId so React remounts all stateful children when
  // navigating between conversations (Link changes search params, loader re-runs,
  // but without a key change the component instance is reused and useState
  // initializers / useRef initializations don't re-run).
  const conversationKey = activeConversation?.chatId ?? "new";
  return <PlaygroundChat key={conversationKey} />;
}

const PARENT_ROUTE_ID =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.playground";

function PlaygroundChat() {
  const { agent, apiOrigin, recentConversations, activeConversation } =
    useTypedLoaderData<typeof loader>();
  const parentData = useRouteLoaderData(PARENT_ROUTE_ID) as
    | { agents: Array<{ slug: string }> }
    | undefined;
  const agents = parentData?.agents ?? [];
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const [conversationId, setConversationId] = useState<string | null>(() =>
    activeConversation
      ? recentConversations.find((c) => c.chatId === activeConversation.chatId)?.id ?? null
      : null
  );
  const [chatId, setChatId] = useState(() => activeConversation?.chatId ?? crypto.randomUUID());
  const [clientDataJson, setClientDataJson] = useState(() =>
    activeConversation?.clientData ? JSON.stringify(activeConversation.clientData, null, 2) : "{}"
  );
  const clientDataJsonRef = useRef(clientDataJson);
  clientDataJsonRef.current = clientDataJson;
  const [machine, setMachine] = useState<string | undefined>(undefined);
  const [tags, setTags] = useState<string>("");

  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/playground/action`;

  // Server-side trigger via Remix action (acts like a Next.js server action)
  const triggerTask = useCallback(
    async (params: TriggerChatTaskParams): Promise<TriggerChatTaskResult> => {
      const formData = new FormData();
      formData.set("intent", "trigger");
      formData.set("agentSlug", agent.slug);
      formData.set("chatId", chatId);
      formData.set("payload", JSON.stringify(params.payload));
      formData.set("clientData", clientDataJsonRef.current);
      if (tags.trim()) formData.set("tags", tags.trim());
      if (machine) formData.set("machine", machine);

      const response = await fetch(actionPath, { method: "POST", body: formData });
      const data = (await response.json()) as {
        runId?: string;
        publicAccessToken?: string;
        conversationId?: string;
        error?: string;
      };

      if (!response.ok || !data.runId || !data.publicAccessToken) {
        throw new Error(data.error ?? "Failed to trigger agent");
      }

      if (data.conversationId) {
        setConversationId(data.conversationId);
      }

      return { runId: data.runId, publicAccessToken: data.publicAccessToken };
    },
    [actionPath, agent.slug, chatId, tags, machine]
  );

  // Token renewal via Remix action
  const renewToken = useCallback(
    async ({ runId }: { chatId: string; runId: string }): Promise<string | undefined> => {
      const formData = new FormData();
      formData.set("intent", "renew");
      formData.set("agentSlug", agent.slug);
      formData.set("runId", runId);

      const response = await fetch(actionPath, { method: "POST", body: formData });
      const data = (await response.json()) as { publicAccessToken?: string };
      return data.publicAccessToken;
    },
    [actionPath, agent.slug]
  );

  // Resource route prefix — all realtime traffic goes through session-authed routes
  const playgroundBaseURL = `${apiOrigin}/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/playground`;

  // Create TriggerChatTransport directly (not via useTriggerChatTransport hook
  // to avoid React version mismatch between SDK and webapp)
  const transportRef = useRef<TriggerChatTransport | null>(null);
  if (transportRef.current === null) {
    transportRef.current = new TriggerChatTransport({
      task: agent.slug,
      triggerTask,
      renewRunAccessToken: renewToken,
      baseURL: playgroundBaseURL,
      clientData: JSON.parse(clientDataJson || "{}") as Record<string, unknown>,
      ...(activeConversation?.runFriendlyId && activeConversation?.publicAccessToken
        ? {
            sessions: {
              [activeConversation.chatId]: {
                runId: activeConversation.runFriendlyId,
                publicAccessToken: activeConversation.publicAccessToken,
                lastEventId: activeConversation.lastEventId ?? undefined,
              },
            },
          }
        : {}),
    });
  }
  const transport = transportRef.current;

  // Keep callbacks up to date
  useEffect(() => {
    transport.setTriggerTask(triggerTask);
  }, [triggerTask, transport]);

  useEffect(() => {
    transport.setRenewRunAccessToken(renewToken);
  }, [renewToken, transport]);

  // Initial messages from persisted conversation (for resume)
  const initialMessages = activeConversation?.messages
    ? (activeConversation.messages as UIMessage[])
    : [];

  // Track the initial message count so we only save after genuinely new turns
  // (not during resume replay which re-fires onFinish for replayed turns)
  const initialMessageCountRef = useRef(initialMessages?.length ?? 0);

  // Save messages after each turn completes
  const saveMessages = useCallback(
    (allMessages: UIMessage[]) => {
      // Skip saves during resume replay — only save when we have more messages than we started with
      if (allMessages.length <= initialMessageCountRef.current) return;

      const currentSession = transport.getSession(chatId);
      const lastEventId = currentSession?.lastEventId;

      const formData = new FormData();
      formData.set("intent", "save");
      formData.set("agentSlug", agent.slug);
      formData.set("chatId", chatId);
      formData.set("messages", JSON.stringify(allMessages));
      if (lastEventId) formData.set("lastEventId", lastEventId);

      // Fire and forget
      fetch(actionPath, { method: "POST", body: formData }).catch(() => {});

      // Update the baseline so subsequent saves work correctly
      initialMessageCountRef.current = allMessages.length;
    },
    [chatId, agent.slug, actionPath, transport]
  );

  // useChat from AI SDK — handles message accumulation, streaming, stop
  const { messages, sendMessage, stop, status, error } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
    onFinish: ({ messages: allMessages }) => {
      saveMessages(allMessages);
    },
  });

  const isStreaming = status === "streaming";
  const isSubmitted = status === "submitted";

  // Pending messages — steering during streaming
  const pending = usePlaygroundPendingMessages({
    transport,
    chatId,
    status,
    messages,
    sendMessage,
    metadata: safeParseJson(clientDataJson),
  });

  const [input, setInput] = useState("");
  const [preloading, setPreloading] = useState(false);
  const [preloaded, setPreloaded] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const session = transport.getSession(chatId);

  const handlePreload = useCallback(async () => {
    setPreloading(true);
    try {
      await transport.preload(chatId, {
        idleTimeoutInSeconds: 60,
        metadata: safeParseJson(clientDataJsonRef.current),
      });
      setPreloaded(true);
      inputRef.current?.focus();
    } finally {
      setPreloading(false);
    }
  }, [transport, chatId]);

  const handleNewConversation = useCallback(() => {
    // Navigate without ?conversation= so the loader returns activeConversation=null
    // and the key changes to "new", causing a full remount with fresh state.
    navigate(window.location.pathname);
  }, [navigate]);

  const handleDeleteConversation = useCallback(async () => {
    if (!conversationId) return;

    const formData = new FormData();
    formData.set("intent", "delete");
    formData.set("agentSlug", agent.slug);
    formData.set("deleteConversationId", conversationId);

    await fetch(actionPath, { method: "POST", body: formData });
    handleNewConversation();
  }, [conversationId, agent.slug, actionPath, handleNewConversation]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;

    setInput("");
    // steer() handles both cases: sends via input stream during streaming,
    // or sends as a normal message when ready
    pending.steer(trimmed);
  }, [input, pending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel id="playground-chat" min="300px">
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-grid-bright px-4 py-2">
            <div className="flex items-center gap-2">
              <Select
                value={agent.slug}
                setValue={(slug) => {
                  if (slug && typeof slug === "string" && slug !== agent.slug) {
                    navigate(v3PlaygroundAgentPath(organization, project, environment, slug));
                  }
                }}
                icon={<CpuChipIcon className="size-4 text-indigo-500" />}
                text={(val) => val || undefined}
                variant="tertiary/small"
                items={agents}
                filter={(item, search) =>
                  item.slug.toLowerCase().includes(search.toLowerCase())
                }
              >
                {(matches) =>
                  matches.map((a) => (
                    <SelectItem key={a.slug} value={a.slug}>
                      <div className="flex items-center gap-2">
                        <CpuChipIcon className="size-3.5 text-indigo-500" />
                        <span>{a.slug}</span>
                      </div>
                    </SelectItem>
                  ))
                }
              </Select>
              <Badge variant="extra-small">{formatAgentType(agent.type)}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {session?.runId && (
                <LinkButton to={`/runs/${session.runId}`} variant="tertiary/small">
                  View run
                </LinkButton>
              )}
              {messages.length > 0 && (
                <CopyButton
                  value={JSON.stringify(messages, null, 2)}
                  variant="button"
                  size="extra-small"
                  showTooltip={false}
                >
                  Copy raw
                </CopyButton>
              )}
              <RecentConversationsPopover
                conversations={recentConversations}
                actionPath={actionPath}
              />
              {conversationId && (
                <Button
                  variant="tertiary/small"
                  LeadingIcon={TrashIcon}
                  onClick={handleDeleteConversation}
                />
              )}
              <Button
                variant="tertiary/small"
                LeadingIcon={ArrowPathIcon}
                onClick={handleNewConversation}
              >
                New conversation
              </Button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <MainCenteredContainer>
                <div className="flex flex-col items-center gap-3 py-16">
                  {preloaded ? (
                    <>
                      <BoltIcon className="size-10 text-success/50" />
                      <Header3 className="text-text-dimmed">Preloaded</Header3>
                      <Paragraph variant="small" className="max-w-sm text-center text-text-dimmed">
                        Agent is warmed up and waiting. Type a message below to start.
                      </Paragraph>
                    </>
                  ) : (
                    <>
                      <CpuChipIcon className="size-10 text-indigo-500/50" />
                      <Header3 className="text-text-dimmed">Start a conversation</Header3>
                      <Paragraph variant="small" className="max-w-sm text-center text-text-dimmed">
                        Type a message below to start testing{" "}
                        <code className="text-text-bright">{agent.slug}</code>
                      </Paragraph>
                      {!session?.runId && (
                        <Button
                          variant="tertiary/small"
                          LeadingIcon={preloading ? Spinner : BoltIcon}
                          onClick={handlePreload}
                          disabled={preloading}
                        >
                          {preloading ? "Preloading..." : "Preload"}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </MainCenteredContainer>
            ) : (
              <div className="mx-auto max-w-3xl space-y-4">
                {messages.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} />
                ))}
                {isSubmitted && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-2 rounded-lg bg-charcoal-750 px-4 py-2.5">
                      <Spinner className="size-3" />
                      <span className="text-sm text-text-dimmed">Thinking...</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mx-4 mb-2 flex items-start gap-2 rounded border border-error/30 bg-error/10 px-3 py-2">
              <span className="flex-1 text-xs text-error">{error.message}</span>
            </div>
          )}

          {/* Input */}
          <div className="border-t border-grid-bright p-4">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isStreaming ? "Send a steering message..." : "Type a message..."}
                rows={1}
                className="flex-1 resize-none rounded-lg border border-charcoal-650 bg-charcoal-850 px-3 py-2.5 text-sm text-text-bright placeholder-text-dimmed focus:border-indigo-500 focus:outline-none"
                style={{ minHeight: "40px", maxHeight: "120px" }}
              />
              <div className="flex items-end gap-1.5">
                {isStreaming && (
                  <Button variant="danger/small" LeadingIcon={StopIcon} onClick={stop}>
                    Stop
                  </Button>
                )}
                <Button
                  variant={isStreaming ? "tertiary/small" : "primary/small"}
                  LeadingIcon={ArrowUpIcon}
                  onClick={handleSend}
                  disabled={!input.trim()}
                >
                  {isStreaming ? "Steer" : "Send"}
                </Button>
              </div>
            </div>
            {/* Pending messages overlay */}
            {pending.pending.length > 0 && (
              <div className="mx-auto mt-1.5 max-w-3xl space-y-1">
                {pending.pending.map((msg) => (
                  <div key={msg.id} className="flex items-center gap-2 text-[10px]">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5",
                        msg.mode === "steering"
                          ? "bg-amber-500/10 text-amber-400"
                          : "bg-charcoal-700 text-text-dimmed"
                      )}
                    >
                      {msg.mode === "steering" ? "Steering" : "Queued"}
                    </span>
                    <span className="truncate text-text-dimmed">{msg.text}</span>
                    {msg.injected && <span className="text-success">Injected</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="mx-auto mt-1.5 max-w-3xl">
              <span className="text-[10px] text-text-dimmed">
                {isStreaming
                  ? "Send a steering message to guide the agent between tool calls"
                  : "Press Enter to send, Shift+Enter for new line"}
              </span>
            </div>
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle id="playground-sidebar-handle" />
      <ResizablePanel id="playground-sidebar" default="320px" min="250px" max="500px">
        <PlaygroundSidebar
          clientDataJson={clientDataJson}
          onClientDataChange={setClientDataJson}
          getCurrentClientData={() => clientDataJsonRef.current}
          clientDataSchema={agent.clientDataSchema}
          agentSlug={agent.slug}
          machine={machine}
          onMachineChange={setMachine}
          tags={tags}
          onTagsChange={setTags}
          session={session}
          messageCount={messages.length}
          isStreaming={isStreaming}
          status={status}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function formatAgentType(type: string): string {
  switch (type) {
    case "ai-sdk-chat":
      return "AI SDK Chat";
    default:
      return type;
  }
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

// UIMessage part types (AI SDK):
//   text           — markdown text content
//   reasoning      — model reasoning/thinking
//   tool-{name}    — tool call with input/output/state
//   source-url     — citation link
//   source-document — citation document reference
//   file           — file attachment (image, etc.)
//   step-start     — visual separator between steps (skip)
//   data-{name}    — custom data parts (skip)

function MessageBubble({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    const text =
      message.parts
        ?.filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("") ?? "";

    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-indigo-600 px-4 py-2.5 text-sm text-white">
          <div className="whitespace-pre-wrap">{text}</div>
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    const hasContent = message.parts && message.parts.length > 0;
    if (!hasContent) return null;

    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] space-y-2">
          {message.parts?.map((part, i) => renderPart(part, i))}
        </div>
      </div>
    );
  }

  return null;
}

function renderPart(part: UIMessage["parts"][number], i: number) {
  const p = part as any;
  const type = part.type as string;

  // Text — markdown rendered via AssistantResponse
  if (type === "text") {
    return p.text ? <AssistantResponse key={i} text={p.text} headerLabel="" /> : null;
  }

  // Reasoning — amber-bordered italic block
  if (type === "reasoning") {
    return (
      <div key={i} className="border-l-2 border-amber-500/40 pl-2">
        <ChatBubble>
          <div className="whitespace-pre-wrap text-xs italic text-amber-200/70">{p.text ?? ""}</div>
        </ChatBubble>
      </div>
    );
  }

  // Tool call — type: "tool-{name}" with toolCallId, input, output, state
  if (type.startsWith("tool-")) {
    const toolName = type.slice(5);
    return (
      <ToolUseRow
        key={i}
        tool={{
          toolCallId: p.toolCallId ?? `tool-${i}`,
          toolName,
          inputJson: JSON.stringify(p.input ?? {}, null, 2),
          resultOutput:
            p.output != null
              ? typeof p.output === "string"
                ? p.output
                : JSON.stringify(p.output, null, 2)
              : undefined,
          resultSummary:
            p.state === "input-streaming" || p.state === "input-available"
              ? "calling..."
              : p.state === "output-error"
              ? `error: ${p.errorText ?? "unknown"}`
              : undefined,
        }}
      />
    );
  }

  // Source URL — clickable citation link
  if (type === "source-url") {
    return (
      <div key={i} className="text-xs">
        <a
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 underline hover:text-indigo-300"
        >
          {p.title || p.url}
        </a>
      </div>
    );
  }

  // Source document — citation label
  if (type === "source-document") {
    return (
      <div key={i} className="text-xs text-text-dimmed">
        📄 {p.title}
        {p.mediaType ? ` (${p.mediaType})` : ""}
      </div>
    );
  }

  // File — render as image if image type, otherwise as download link
  if (type === "file") {
    const isImage = typeof p.mediaType === "string" && p.mediaType.startsWith("image/");
    if (isImage) {
      return (
        <img
          key={i}
          src={p.url}
          alt={p.filename ?? "file"}
          className="max-h-64 rounded border border-charcoal-650"
        />
      );
    }
    return (
      <div key={i} className="text-xs">
        <a
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 underline hover:text-indigo-300"
        >
          {p.filename ?? "Download file"}
        </a>
      </div>
    );
  }

  // Step start — subtle dashed separator with centered label
  if (type === "step-start") {
    return (
      <div key={i} className="flex items-center gap-2 py-0.5">
        <div className="flex-1 border-t border-dashed border-charcoal-650" />
        <span className="text-[10px] text-charcoal-500">step</span>
        <div className="flex-1 border-t border-dashed border-charcoal-650" />
      </div>
    );
  }

  // Data parts — type: "data-{name}", show as labeled JSON popover
  if (type.startsWith("data-")) {
    const dataName = type.slice(5);
    return <DataPartPopover key={i} name={dataName} data={p.data} />;
  }

  return null;
}

function DataPartPopover({ name, data }: { name: string; data: unknown }) {
  const formatted = JSON.stringify(data, null, 2);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-charcoal-650 bg-charcoal-800 px-1.5 py-0.5 font-mono text-[10px] text-text-dimmed transition-colors hover:border-charcoal-500 hover:text-text-bright"
        >
          <span className="text-purple-400">{name}</span>
          <span className="text-charcoal-500">{"{}"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-md p-0" align="start" sideOffset={4}>
        <div className="flex items-center justify-between border-b border-charcoal-650 px-2.5 py-1.5">
          <span className="text-[10px] font-medium text-text-dimmed">data-{name}</span>
        </div>
        <div className="max-h-60 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <pre className="p-2.5 text-[11px] leading-relaxed text-text-bright">{formatted}</pre>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const machinePresets = [
  "micro",
  "small-1x",
  "small-2x",
  "medium-1x",
  "medium-2x",
  "large-1x",
  "large-2x",
];

function PlaygroundSidebar({
  clientDataJson,
  onClientDataChange,
  getCurrentClientData,
  clientDataSchema,
  agentSlug,
  machine,
  onMachineChange,
  tags,
  onTagsChange,
  session,
  messageCount,
  isStreaming,
  status,
}: {
  clientDataJson: string;
  onClientDataChange: (val: string) => void;
  getCurrentClientData: () => string;
  clientDataSchema: unknown;
  agentSlug: string;
  machine: string | undefined;
  onMachineChange: (val: string | undefined) => void;
  tags: string;
  onTagsChange: (val: string) => void;
  session: { runId: string; publicAccessToken: string; lastEventId?: string } | undefined;
  messageCount: number;
  isStreaming: boolean;
  status: string;
}) {
  return (
    <div className="flex h-full flex-col border-l border-grid-bright">
      <ClientTabs
        defaultValue="clientData"
        className="flex h-full min-h-0 flex-col overflow-hidden pt-1"
      >
        <div className="h-fit overflow-x-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <ClientTabsList variant="underline" className="mx-3 shrink-0">
            <ClientTabsTrigger
              value="clientData"
              variant="underline"
              layoutId="playground-sidebar-tabs"
              className="shrink-0"
            >
              Client Data
            </ClientTabsTrigger>
            <ClientTabsTrigger
              value="options"
              variant="underline"
              layoutId="playground-sidebar-tabs"
              className="shrink-0"
            >
              Options
            </ClientTabsTrigger>
            <ClientTabsTrigger
              value="session"
              variant="underline"
              layoutId="playground-sidebar-tabs"
              className="shrink-0"
            >
              Session
            </ClientTabsTrigger>
          </ClientTabsList>
        </div>

        {/* Client Data tab */}
        <ClientTabsContent
          value="clientData"
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <div className="min-w-64 space-y-4 p-3">
            <div>
              <p className="mb-2 text-xs text-text-dimmed">
                Custom metadata sent with each conversation turn.
              </p>
              <div className="overflow-hidden rounded border border-charcoal-650">
                <JSONEditor
                  defaultValue={clientDataJson}
                  readOnly={false}
                  onChange={onClientDataChange}
                  minHeight="120px"
                  maxHeight="300px"
                  showClearButton={true}
                  showCopyButton={true}
                />
              </div>
            </div>

            <AIPayloadTabContent
              onPayloadGenerated={onClientDataChange}
              payloadSchema={clientDataSchema ?? undefined}
              taskIdentifier={agentSlug}
              getCurrentPayload={getCurrentClientData}
              generateButtonLabel="Generate client data"
              placeholder="e.g. generate client data for a free-tier user"
              examplePromptsOverride={[
                "Generate valid client data",
                "Generate client data with all fields",
                "Generate client data with edge cases",
              ]}
            />

            {clientDataSchema != null && (
              <SchemaTabContent
                schema={clientDataSchema}
                title="Schema"
                description="JSON Schema for the agent's client data."
                showDocsLink={false}
              />
            )}
          </div>
        </ClientTabsContent>

        {/* Options tab */}
        <ClientTabsContent
          value="options"
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <div className="min-w-64 space-y-4 p-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-dimmed">Machine</label>
              <select
                value={machine ?? ""}
                onChange={(e) => onMachineChange(e.target.value || undefined)}
                className="w-full rounded border border-charcoal-650 bg-charcoal-850 px-2.5 py-1.5 text-xs text-text-bright focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Default</option>
                {machinePresets.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-text-dimmed">Machine preset for the agent run.</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-text-dimmed">Tags</label>
              <input
                type="text"
                value={tags}
                onChange={(e) => onTagsChange(e.target.value)}
                placeholder="tag1, tag2"
                className="w-full rounded border border-charcoal-650 bg-charcoal-850 px-2.5 py-1.5 text-xs text-text-bright placeholder-text-dimmed focus:border-indigo-500 focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-text-dimmed">
                Comma-separated tags (max 5 total).
              </p>
            </div>
          </div>
        </ClientTabsContent>

        {/* Session tab */}
        <ClientTabsContent
          value="session"
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <div className="min-w-64 space-y-3 p-3">
            {session?.runId ? (
              <>
                <SessionField label="Run ID" value={session.runId} />
                <SessionField label="Messages" value={String(messageCount)} />
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-text-dimmed">
                    Status
                  </label>
                  <span className="flex items-center gap-1.5 text-xs">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        isStreaming ? "animate-pulse bg-success" : "bg-blue-500"
                      )}
                    />
                    <span className="capitalize text-text-bright">{status}</span>
                  </span>
                </div>
              </>
            ) : (
              <p className="text-xs text-text-dimmed">
                No active session. Send a message to start a conversation.
              </p>
            )}
          </div>
        </ClientTabsContent>
      </ClientTabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending messages hook (reimplemented to avoid React version mismatch)
// ---------------------------------------------------------------------------

const PENDING_MESSAGE_INJECTED_TYPE = "data-pending-message-injected";

type PendingMessageEntry = {
  id: string;
  text: string;
  mode: "steering" | "queued";
  injected: boolean;
};

function usePlaygroundPendingMessages({
  transport,
  chatId,
  status,
  messages,
  sendMessage,
  metadata,
}: {
  transport: TriggerChatTransport;
  chatId: string;
  status: string;
  messages: UIMessage[];
  sendMessage: (msg: { text: string }, opts?: { metadata?: Record<string, unknown> }) => void;
  metadata?: Record<string, unknown>;
}) {
  type InternalMsg = {
    id: string;
    role: "user";
    parts: { type: "text"; text: string }[];
    _mode: "steering" | "queued";
  };
  const [pendingMsgs, setPendingMsgs] = useState<InternalMsg[]>([]);
  const injectedIdsRef = useRef<Set<string>>(new Set());
  const prevStatusRef = useRef(status);

  // Watch for injection confirmation chunks
  useEffect(() => {
    if (status !== "streaming") return;
    let newlyInjected = false;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts ?? []) {
        if ((part as any).type === PENDING_MESSAGE_INJECTED_TYPE) {
          const messageIds = (part as any).data?.messageIds as string[] | undefined;
          if (Array.isArray(messageIds)) {
            for (const id of messageIds) {
              if (!injectedIdsRef.current.has(id)) {
                injectedIdsRef.current.add(id);
                newlyInjected = true;
              }
            }
          }
        }
      }
    }
    if (newlyInjected) {
      setPendingMsgs((prev) => prev.filter((m) => !injectedIdsRef.current.has(m.id)));
    }
  }, [status, messages]);

  // Handle turn completion — auto-send non-injected messages as next turn
  useEffect(() => {
    const turnCompleted = prevStatusRef.current === "streaming" && status === "ready";
    prevStatusRef.current = status;
    if (!turnCompleted) return;

    const toSend = pendingMsgs.filter((m) => !injectedIdsRef.current.has(m.id));
    setPendingMsgs([]);
    injectedIdsRef.current.clear();

    if (toSend.length > 0) {
      const text = toSend.map((m) => m.parts[0]?.text ?? "").join("\n");
      sendMessage({ text }, metadata ? { metadata } : undefined);
    }
  }, [status, pendingMsgs, sendMessage, metadata, messages]);

  const steer = useCallback(
    (text: string) => {
      if (status === "streaming") {
        const msg: InternalMsg = {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text }],
          _mode: "steering",
        };
        transport.sendPendingMessage(chatId, msg as any, metadata);
        setPendingMsgs((prev) => [...prev, msg]);
      } else {
        sendMessage({ text }, metadata ? { metadata } : undefined);
      }
    },
    [status, transport, chatId, sendMessage, metadata]
  );

  const pending: PendingMessageEntry[] = pendingMsgs.map((m) => ({
    id: m.id,
    text: m.parts[0]?.text ?? "",
    mode: m._mode,
    injected: injectedIdsRef.current.has(m.id),
  }));

  return { pending, steer };
}

function RecentConversationsPopover({
  conversations,
  actionPath,
}: {
  conversations: PlaygroundConversation[];
  actionPath: string;
}) {
  const fetcher = useFetcher();
  const [isOpen, setIsOpen] = useState(false);

  const deletingId =
    fetcher.state !== "idle" ? (fetcher.formData?.get("deleteConversationId") as string) : null;

  const handleDelete = useCallback(
    (e: React.MouseEvent, conv: PlaygroundConversation) => {
      e.preventDefault();
      e.stopPropagation();

      fetcher.submit(
        {
          intent: "delete",
          agentSlug: conv.agentSlug,
          deleteConversationId: conv.id,
        },
        { method: "POST", action: actionPath }
      );
      setIsOpen(false);
    },
    [actionPath, fetcher]
  );

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="tertiary/small"
          LeadingIcon={ClockRotateLeftIcon}
          disabled={conversations.length === 0}
        >
          Recent
        </Button>
      </PopoverTrigger>
      <PopoverContent className="min-w-[320px] p-0" align="end" sideOffset={6}>
        <div className="max-h-80 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <div className="p-1">
            {conversations.map((conv) => (
              <div
                key={conv.id}
                className={cn(
                  "group flex items-center gap-1 rounded-sm px-2 py-2 transition-colors hover:bg-charcoal-900",
                  deletingId === conv.id && "pointer-events-none opacity-50"
                )}
              >
                <Link
                  to={`?conversation=${conv.id}`}
                  onClick={() => setIsOpen(false)}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 outline-none focus-custom"
                >
                  <Paragraph variant="small/bright" className="line-clamp-1 text-left">
                    {conv.title}
                  </Paragraph>
                  <div className="text-xs text-text-dimmed">
                    <DateTime date={conv.updatedAt} showTooltip={false} />
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={(e) => handleDelete(e, conv)}
                  className="shrink-0 rounded p-1 text-text-dimmed opacity-0 transition-opacity group-hover:opacity-100 hover:text-error"
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </div>
            ))}
            {conversations.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-text-dimmed">
                No recent conversations
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function safeParseJson(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function SessionField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-text-dimmed">
        {label}
      </label>
      <code className="block truncate text-xs text-text-bright">{value}</code>
    </div>
  );
}
