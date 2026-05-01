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
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyButton } from "~/components/primitives/CopyButton";
import { DurationPicker } from "~/components/primitives/DurationPicker";
import { Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { ClockRotateLeftIcon } from "~/assets/icons/ClockRotateLeftIcon";
import type { PlaygroundConversation } from "~/presenters/v3/PlaygroundPresenter.server";
import { DateTime } from "~/components/primitives/DateTime";
import { cn } from "~/utils/cn";
import { JSONEditor } from "~/components/code/JSONEditor";
import { ToolUseRow, AssistantResponse, ChatBubble } from "~/components/runs/v3/ai/AIChatMessages";
import { MessageBubble } from "~/components/runs/v3/agent/AgentMessageView";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";
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
import { RunTagInput } from "~/components/runs/v3/RunTagInput";
import { Select, SelectItem } from "~/components/primitives/Select";
import { EnvironmentParamSchema, v3PlaygroundAgentPath } from "~/utils/pathBuilder";
import { env as serverEnv } from "~/env.server";
import { generateJWT as internal_generateJWT, MachinePresetName } from "@trigger.dev/core/v3";
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
  const { agent, activeConversation } = useTypedLoaderData<typeof loader>();
  // Key on agent slug + conversation chatId so React remounts all stateful
  // children when switching agents or navigating between conversations.
  // Without the agent slug, switching agents keeps key="new" and React
  // reuses the component — useState initializers don't re-run.
  const conversationKey = `${agent.slug}:${activeConversation?.chatId ?? "new"}`;
  return <PlaygroundChat key={conversationKey} />;
}

const PARENT_ROUTE_ID =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.playground";

function PlaygroundChat() {
  const { agent, apiOrigin, recentConversations, activeConversation } =
    useTypedLoaderData<typeof loader>();
  const parentData = useRouteLoaderData(PARENT_ROUTE_ID) as
    | {
        agents: Array<{ slug: string }>;
        versions: string[];
        regions: Array<{
          id: string;
          name: string;
          description?: string;
          isDefault: boolean;
        }>;
        isDev: boolean;
      }
    | undefined;
  const agents = parentData?.agents ?? [];
  const versions = parentData?.versions ?? [];
  const regions = parentData?.regions ?? [];
  const isDev = parentData?.isDev ?? false;
  const defaultRegion = regions.find((r) => r.isDefault);
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
  const [tags, setTags] = useState<string[]>([]);
  const [maxAttempts, setMaxAttempts] = useState<number | undefined>(undefined);
  const [maxDuration, setMaxDuration] = useState<number | undefined>(undefined);
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [region, setRegion] = useState<string | undefined>(() =>
    isDev ? undefined : defaultRegion?.name
  );

  const actionPath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/playground/action`;

  // Server-side `start` via Remix action — atomically creates the
  // backing Session for `chatId` and triggers the first run, returns
  // the session-scoped PAT. Idempotent: called on initial use AND on
  // 401, so the same code path serves both first-run and PAT renewal.
  const startSession = useCallback(
    async (): Promise<string> => {
      const formData = new FormData();
      formData.set("intent", "start");
      formData.set("agentSlug", agent.slug);
      formData.set("chatId", chatId);
      formData.set("clientData", clientDataJsonRef.current);
      if (tags.length > 0) formData.set("tags", tags.join(","));
      if (machine) formData.set("machine", machine);
      if (maxAttempts) formData.set("maxAttempts", String(maxAttempts));
      if (maxDuration) formData.set("maxDuration", String(maxDuration));
      if (version) formData.set("version", version);
      if (region) formData.set("region", region);

      const response = await fetch(actionPath, { method: "POST", body: formData });
      const data = (await response.json()) as {
        runId?: string;
        publicAccessToken?: string;
        conversationId?: string;
        error?: string;
      };

      if (!response.ok || !data.publicAccessToken) {
        throw new Error(data.error ?? "Failed to start chat session");
      }

      if (data.conversationId) {
        setConversationId(data.conversationId);
      }

      return data.publicAccessToken;
    },
    [actionPath, agent.slug, chatId, tags, machine, maxAttempts, maxDuration, version, region]
  );

  // Resource route prefix — all realtime traffic goes through session-authed routes
  const playgroundBaseURL = `${apiOrigin}/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/playground`;

  // Create TriggerChatTransport directly (not via useTriggerChatTransport hook
  // to avoid React version mismatch between SDK and webapp)
  const transportRef = useRef<TriggerChatTransport | null>(null);
  if (transportRef.current === null) {
    transportRef.current = new TriggerChatTransport({
      task: agent.slug,
      // The Remix action is idempotent on `(env, externalId)` and
      // returns a fresh session PAT every time, so it serves both
      // first-run create and PAT renewal. `startSession` runs on
      // `transport.preload(chatId)` and lazily on the first
      // `sendMessage`; `accessToken` runs on a 401/403 from any
      // session-PAT-authed request. Wiring the same call to both
      // keeps the Preload button working without a separate refresh
      // route.
      startSession: async () => ({ publicAccessToken: await startSession() }),
      accessToken: () => startSession(),
      baseURL: playgroundBaseURL,
      clientData: JSON.parse(clientDataJson || "{}") as Record<string, unknown>,
      ...(activeConversation?.publicAccessToken
        ? {
            sessions: {
              [activeConversation.chatId]: {
                publicAccessToken: activeConversation.publicAccessToken,
                lastEventId: activeConversation.lastEventId ?? undefined,
              },
            },
          }
        : {}),
    });
  }
  const transport = transportRef.current;

  // Keep the transport's `defaultMetadata` in sync with the JSON editor.
  // Without this the transport uses the value captured at construction for
  // every per-turn metadata merge, even after the user edits the JSON.
  // `startSession` reads from `clientDataJsonRef.current` directly so session
  // creation is unaffected — this only fixes the per-turn metadata path.
  useEffect(() => {
    transport.setClientData(JSON.parse(clientDataJson || "{}") as Record<string, unknown>);
  }, [clientDataJson, transport]);

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

  // Sticky-bottom auto-scroll for the messages list. The hook walks up to
  // the surrounding `overflow-y-auto` panel and follows the conversation
  // as new chunks stream in — pauses if you scroll up to read history,
  // resumes when you scroll back into the bottom band. Same behavior as
  // the run-inspector Agent tab.
  const messagesRootRef = useAutoScrollToBottom([messages, isSubmitted]);

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
      await transport.preload(chatId);
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
              {activeConversation?.runFriendlyId && (
                <LinkButton
                  to={`/runs/${activeConversation.runFriendlyId}`}
                  variant="tertiary/small"
                >
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
          <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
                      {!session && (
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
              <div ref={messagesRootRef} className="mx-auto w-full max-w-4xl space-y-4">
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
      <ResizablePanel id="playground-sidebar" default="420px" min="360px" max="720px">
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
          maxAttempts={maxAttempts}
          onMaxAttemptsChange={setMaxAttempts}
          maxDuration={maxDuration}
          onMaxDurationChange={setMaxDuration}
          version={version}
          onVersionChange={setVersion}
          versions={versions}
          region={region}
          onRegionChange={setRegion}
          regions={regions}
          isDev={isDev}
          session={session}
          runFriendlyId={activeConversation?.runFriendlyId ?? undefined}
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

// Message rendering — `MessageBubble` is imported from
// `~/components/runs/v3/agent/AgentMessageView`. The same module is used by
// the run details Agent view so both surfaces stay in sync.

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const machinePresets = Object.values(MachinePresetName.enum);

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
  maxAttempts,
  onMaxAttemptsChange,
  maxDuration,
  onMaxDurationChange,
  version,
  onVersionChange,
  versions,
  region,
  onRegionChange,
  regions,
  isDev,
  session,
  runFriendlyId,
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
  tags: string[];
  onTagsChange: (val: string[]) => void;
  maxAttempts: number | undefined;
  onMaxAttemptsChange: (val: number | undefined) => void;
  maxDuration: number | undefined;
  onMaxDurationChange: (val: number | undefined) => void;
  version: string | undefined;
  onVersionChange: (val: string | undefined) => void;
  versions: string[];
  region: string | undefined;
  onRegionChange: (val: string | undefined) => void;
  regions: Array<{ id: string; name: string; description?: string; isDefault: boolean }>;
  isDev: boolean;
  session:
    | {
        publicAccessToken: string;
        lastEventId?: string;
        isStreaming?: boolean;
      }
    | undefined;
  /**
   * Friendly id of the latest run for this conversation (drawn from the
   * playground's own `playgroundConversation` table, which mirrors the
   * Session's `currentRunId`). Optional because a conversation may
   * exist briefly before the first run lands.
   */
  runFriendlyId: string | undefined;
  messageCount: number;
  isStreaming: boolean;
  status: string;
}) {
  const regionItems = regions.map((r) => ({
    value: r.name,
    label: r.description ? `${r.name} — ${r.description}` : r.name,
  }));
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
              isAgent={true}
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
          <div className="space-y-4 p-3">
            <InputGroup fullWidth>
              <Label variant="small" required={false}>
                Machine
              </Label>
              <Select
                value={machine ?? ""}
                setValue={(val) =>
                  onMachineChange(val && typeof val === "string" ? val : undefined)
                }
                placeholder="Default"
                variant="tertiary/small"
                items={machinePresets}
                filter={(item, search) => item.toLowerCase().includes(search.toLowerCase())}
              >
                {(matches) =>
                  matches.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {preset}
                    </SelectItem>
                  ))
                }
              </Select>
              <Hint>Overrides the machine preset.</Hint>
            </InputGroup>

            <InputGroup fullWidth>
              <Label variant="small" required={false}>
                Tags
              </Label>
              <RunTagInput
                tags={tags}
                onTagsChange={onTagsChange}
                variant="small"
                maxTags={3}
                placeholder="Add tag..."
              />
              <Hint>Add tags to easily filter runs. 3 max (2 added automatically).</Hint>
            </InputGroup>

            <InputGroup fullWidth>
              <Label variant="small" required={false}>
                Max attempts
              </Label>
              <Input
                type="number"
                variant="small"
                min={1}
                placeholder="Default"
                value={maxAttempts ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  onMaxAttemptsChange(val ? parseInt(val, 10) : undefined);
                }}
              />
              <Hint>Retries failed runs up to the specified number of attempts.</Hint>
            </InputGroup>

            <InputGroup fullWidth>
              <Label variant="small" required={false}>
                Max duration
              </Label>
              <DurationPicker
                value={maxDuration}
                onChange={onMaxDurationChange}
                variant="small"
              />
              <Hint>Overrides the maximum compute time limit for the run.</Hint>
            </InputGroup>

            {versions.length > 0 && (
              <InputGroup fullWidth>
                <Label variant="small" required={false}>
                  Version
                </Label>
                <Select
                  value={version ?? ""}
                  setValue={(val) =>
                    onVersionChange(val && typeof val === "string" ? val : undefined)
                  }
                  placeholder="Latest"
                  variant="tertiary/small"
                  disabled={isDev}
                  items={versions}
                  filter={(item, search) => item.toLowerCase().includes(search.toLowerCase())}
                >
                  {(matches) =>
                    matches.map((v, i) => (
                      <SelectItem key={v} value={v}>
                        {i === 0 ? `${v} (latest)` : v}
                      </SelectItem>
                    ))
                  }
                </Select>
                <Hint>
                  {isDev
                    ? "Version is determined by the running dev server."
                    : "Lock the run to a specific deployed version."}
                </Hint>
              </InputGroup>
            )}

            {regionItems.length > 1 && (
              <InputGroup fullWidth>
                <Label variant="small" required={false}>
                  Region
                </Label>
                <Select
                  value={region ?? ""}
                  setValue={(val) =>
                    onRegionChange(val && typeof val === "string" ? val : undefined)
                  }
                  text={(val) => val || undefined}
                  placeholder={isDev ? "–" : "Default"}
                  variant="tertiary/small"
                  disabled={isDev}
                  items={regionItems}
                  filter={(item, search) =>
                    item.label.toLowerCase().includes(search.toLowerCase())
                  }
                >
                  {(matches) =>
                    matches.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))
                  }
                </Select>
                <Hint>
                  {isDev
                    ? "Region is not applicable in development."
                    : "Run the agent in a specific region."}
                </Hint>
              </InputGroup>
            )}
          </div>
        </ClientTabsContent>

        {/* Session tab */}
        <ClientTabsContent
          value="session"
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <div className="min-w-64 space-y-3 p-3">
            {session ? (
              <>
                {runFriendlyId && (
                  <SessionField label="Run ID" value={runFriendlyId} />
                )}
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
