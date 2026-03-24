import * as Ariakit from "@ariakit/react";
import { ArrowPathIcon, ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { type MetaFunction, useFetcher } from "@remix-run/react";
import {
  type ActionFunctionArgs,
  json,
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/server-runtime";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { CodeBlock } from "~/components/code/CodeBlock";
import { TextEditor } from "~/components/code/TextEditor";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { ModelsFilter } from "~/components/metrics/ModelsFilter";
import { OperationsFilter } from "~/components/metrics/OperationsFilter";
import { ProvidersFilter } from "~/components/metrics/ProvidersFilter";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { CopyButton } from "~/components/primitives/CopyButton";
import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ResizableSnapshot,
} from "~/components/primitives/Resizable";
import {
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
} from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextArea } from "~/components/primitives/TextArea";
import tablerSpritePath from "~/components/primitives/tabler-sprite.svg";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useInterval } from "~/hooks/useInterval";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { type GenerationRow, PromptPresenter } from "~/presenters/v3/PromptPresenter.server";
import { SpanView } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { getResizableSnapshot } from "~/services/resizablePanel.server";
import { requireUserId } from "~/services/session.server";
import { PromptService } from "~/v3/services/promptService.server";

import { z } from "zod";
import { AIPromptsIcon } from "~/assets/icons/AIPromptsIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { TextLink } from "~/components/primitives/TextLink";
import { MetricWidget } from "~/routes/resources.metric";
import { cn } from "~/utils/cn";
import { EnvironmentParamSchema, v3PromptsPath, v3RunSpanPath } from "~/utils/pathBuilder";
import { parsePeriodToMs } from "~/utils/periods";
import { SimpleTooltip } from "~/components/primitives/Tooltip";

const ParamSchema = EnvironmentParamSchema.extend({
  promptSlug: z.string(),
});

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  return [{ title: `${(data as any)?.prompt.slug ?? "Prompt"} | Trigger.dev` }];
};

// ─── Action ──────────────────────────────────────────────

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("promote"),
    versionId: z.string(),
  }),
  z.object({
    intent: z.literal("saveVersion"),
    textContent: z.string().optional(),
    model: z.string().optional(),
    commitMessage: z.string().optional(),
  }),
  z.object({
    intent: z.literal("updateOverride"),
    textContent: z.string().optional(),
    model: z.string().optional(),
    commitMessage: z.string().optional(),
  }),
  z.object({
    intent: z.literal("removeOverride"),
  }),
  z.object({
    intent: z.literal("reactivateOverride"),
    versionId: z.string(),
  }),
]);

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, promptSlug } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) return json({ error: "Environment not found" }, { status: 404 });

  const formData = Object.fromEntries(await request.formData());
  const parsed = ActionSchema.safeParse(formData);
  if (!parsed.success) return json({ error: "Invalid action" }, { status: 400 });

  const prompt = await prisma.prompt.findUnique({
    where: {
      projectId_runtimeEnvironmentId_slug: {
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        slug: promptSlug,
      },
    },
  });

  if (!prompt) return json({ error: "Prompt not found" }, { status: 404 });

  const data = parsed.data;
  const service = new PromptService();

  if (data.intent === "promote") {
    await service.promoteVersion(prompt.id, data.versionId);
    return json({ ok: true });
  }

  const url = new URL(request.url);

  if (data.intent === "saveVersion") {
    const result = await service.createOverride(prompt.id, {
      textContent: data.textContent ?? "",
      model: data.model,
      commitMessage: data.commitMessage,
      source: "dashboard",
      createdBy: userId,
    });
    url.searchParams.set("version", String(result.version));
    return redirect(url.pathname + url.search);
  }

  if (data.intent === "updateOverride") {
    await service.updateOverride(prompt.id, {
      textContent: data.textContent,
      model: data.model,
      commitMessage: data.commitMessage,
    });
    return json({ ok: true });
  }

  if (data.intent === "removeOverride") {
    await service.removeOverride(prompt.id);
    // Navigate back to current version
    const currentVersion = await prisma.promptVersion.findFirst({
      where: { promptId: prompt.id, labels: { has: "current" } },
      select: { version: true },
    });
    if (currentVersion) {
      url.searchParams.set("version", String(currentVersion.version));
    } else {
      url.searchParams.delete("version");
    }
    return redirect(url.pathname + url.search);
  }

  if (data.intent === "reactivateOverride") {
    await service.reactivateOverride(prompt.id, data.versionId);
    return json({ ok: true });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

// ─── Loader ──────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, promptSlug } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  const prompt = await prisma.prompt.findUnique({
    where: {
      projectId_runtimeEnvironmentId_slug: {
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        slug: promptSlug,
      },
    },
    include: {
      versions: { orderBy: { version: "desc" }, take: 50 },
    },
  });

  if (!prompt) throw new Response("Prompt not found", { status: 404 });

  const currentVersion = prompt.versions.find((v) => v.labels.includes("current"));
  const overrideVersion = prompt.versions.find((v) => v.labels.includes("override"));

  // Query ClickHouse for recent generations (for the Generations tab span list)
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "7d";
  const periodMs = parsePeriodToMs(period);
  const fromTime = url.searchParams.get("from");
  const toTime = url.searchParams.get("to");

  const startTime = fromTime ? new Date(fromTime) : new Date(Date.now() - periodMs);
  const endTime = toTime ? new Date(toTime) : new Date();

  const presenter = new PromptPresenter(clickhouseClient);
  let generations: Awaited<ReturnType<typeof presenter.listGenerations>>["generations"] = [];
  let generationsPagination: { next?: string } = {};
  try {
    const urlVersions = url.searchParams
      .getAll("versions")
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n));
    const urlModels = url.searchParams.getAll("models").filter(Boolean);
    const urlOperations = url.searchParams.getAll("operations").filter(Boolean);
    const urlProviders = url.searchParams.getAll("providers").filter(Boolean);

    const result = await presenter.listGenerations({
      environmentId: environment.id,
      promptSlug: prompt.slug,
      promptVersions: urlVersions.length > 0 ? urlVersions : undefined,
      startTime,
      endTime,
      responseModels: urlModels.length > 0 ? urlModels : undefined,
      operations: urlOperations.length > 0 ? urlOperations : undefined,
      providers: urlProviders.length > 0 ? urlProviders : undefined,
    });
    generations = result.generations;
    generationsPagination = result.pagination;
  } catch (e) {
    console.error("Prompt generations query exception:", e);
  }

  // Load distinct filter values and resizable snapshots in parallel
  const distinctQuery = (col: string, name: string) =>
    clickhouseClient.reader.query({
      name,
      query: `SELECT DISTINCT ${col} AS val FROM trigger_dev.llm_metrics_v1 WHERE environment_id = {environmentId: String} AND prompt_slug = {promptSlug: String} AND ${col} != '' ORDER BY val`,
      params: z.object({ environmentId: z.string(), promptSlug: z.string() }),
      schema: z.object({ val: z.string() }),
    })({ environmentId: environment.id, promptSlug: prompt.slug });

  const [
    resizableOuter,
    resizableVertical,
    resizableGenerations,
    [modelsErr, modelsRows],
    [opsErr, opsRows],
    [provsErr, provsRows],
  ] = await Promise.all([
    getResizableSnapshot(request, "prompt-detail"),
    getResizableSnapshot(request, "prompt-vertical"),
    getResizableSnapshot(request, "prompt-generations"),
    distinctQuery("response_model", "promptDistinctModels"),
    distinctQuery("operation_id", "promptDistinctOperations"),
    distinctQuery("gen_ai_system", "promptDistinctProviders"),
  ]);

  const possibleModels = modelsErr ? [] : modelsRows.map((r) => r.val);
  const possibleOperations = opsErr ? [] : opsRows.map((r) => r.val);
  const possibleProviders = provsErr ? [] : provsRows.map((r) => r.val);

  return typedjson({
    resizable: {
      outer: resizableOuter,
      vertical: resizableVertical,
      generations: resizableGenerations,
    },
    prompt: {
      id: prompt.id,
      friendlyId: prompt.friendlyId,
      slug: prompt.slug,
      description: prompt.description,
      tags: prompt.tags,
      defaultModel: prompt.defaultModel,
      defaultConfig: prompt.defaultConfig,
      variableSchema: prompt.variableSchema,
      filePath: prompt.filePath,
      exportName: prompt.exportName,
    },
    currentVersion: currentVersion
      ? {
          id: currentVersion.id,
          version: currentVersion.version,
          textContent: currentVersion.textContent,
          model: currentVersion.model,
          source: currentVersion.source,
          labels: currentVersion.labels,
        }
      : null,
    versions: prompt.versions.map((v) => ({
      id: v.id,
      version: v.version,
      labels: v.labels,
      source: v.source,
      commitMessage: v.commitMessage,
      textContent: v.textContent,
      model: v.model,
      createdAt: v.createdAt,
    })),
    overrideVersion: overrideVersion
      ? {
          id: overrideVersion.id,
          version: overrideVersion.version,
        }
      : null,
    generations,
    generationsPagination,
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    possibleModels,
    possibleOperations,
    possibleProviders,
  });
};

// ─── Helpers ─────────────────────────────────────────────

type VersionData = {
  id: string;
  version: number;
  labels: string[];
  source: string;
  commitMessage: string | null;
  textContent: string | null;
  model: string | null;
  createdAt: Date;
};

type VariableField = {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  placeholder?: string;
  enumValues?: string[];
  isLongText: boolean;
};

function extractVariableFields(schema: unknown): VariableField[] {
  const jsonSchema = schema as {
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
    required?: string[];
  } | null;
  if (!jsonSchema?.properties) return [];
  const requiredSet = new Set(jsonSchema.required ?? []);
  return Object.entries(jsonSchema.properties).map(([name, prop]) => ({
    name,
    type: prop.type ?? "string",
    required: requiredSet.has(name),
    description: prop.description,
    placeholder: prop.description ?? name,
    enumValues: prop.enum,
    isLongText:
      prop.type === "string" &&
      !prop.enum &&
      (name.toLowerCase().includes("text") ||
        name.toLowerCase().includes("content") ||
        name.toLowerCase().includes("message") ||
        name.toLowerCase().includes("body")),
  }));
}

function compileTemplatePreview(template: string, variables: Record<string, string>): string {
  let result = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, key, content) => {
    const value = variables[key];
    return value
      ? content.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => variables[k] ?? "")
      : "";
  });
  result = result.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    return variables[key] ?? `{{${key}}}`;
  });
  return result;
}

function getVersionContent(version: { textContent?: string | null }): string {
  return version.textContent ?? "";
}

// ─── Component ───────────────────────────────────────────

export default function PromptDetailPage() {
  const {
    prompt,
    currentVersion,
    versions,
    overrideVersion,
    generations,
    generationsPagination,
    organizationId,
    projectId,
    environmentId,
    resizable,
    possibleModels,
    possibleOperations,
    possibleProviders,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useFetcher();
  const { value: searchValue, replace: replaceSearch } = useSearchParams();

  const tab = searchValue("tab") ?? "details";
  const contentTab = searchValue("contentTab") ?? "generations";
  const period = searchValue("period") ?? "7d";
  const from = searchValue("from") ?? null;
  const to = searchValue("to") ?? null;

  // Selected span for the generations inspector — auto-select first generation
  const [selectedSpan, setSelectedSpan] = useState<{ runId: string; spanId: string } | null>(
    generations[0] ? { runId: generations[0].run_id, spanId: generations[0].span_id } : null
  );

  // Selected version from URL or default to current
  const versionParam = searchValue("version");
  const selectedVersion = versionParam
    ? versions.find((v) => v.version === Number(versionParam)) ?? versions[0]
    : overrideVersion
    ? versions.find((v) => v.id === overrideVersion.id) ?? versions[0]
    : currentVersion
    ? versions.find((v) => v.id === currentVersion.id) ?? versions[0]
    : versions[0];

  const content = selectedVersion ? getVersionContent(selectedVersion) : "";
  const isCurrent = selectedVersion?.labels.includes("current") ?? false;

  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);

  const handlePromote = (versionId: string) => {
    fetcher.submit({ intent: "promote", versionId }, { method: "POST" });
  };

  const switchVersion = (versionNumber: number) => {
    replaceSearch({
      version: String(versionNumber),
      tab,
    });
  };

  return (
    <PageContainer className="grid-rows-[auto_auto_1fr]">
      <NavBar>
        <PageTitle
          title={
            <PromptCopyPopover
              slug={prompt.slug}
              friendlyId={prompt.friendlyId}
              description={prompt.description}
            />
          }
          backButton={{ to: v3PromptsPath(organization, project, environment), text: "Prompts" }}
        />
        <PageAccessories>
          <div className="flex items-center gap-2">
            {selectedVersion && (
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    selectedVersion.labels.includes("override")
                      ? "bg-amber-400"
                      : isCurrent
                      ? "bg-green-500"
                      : "bg-charcoal-550"
                  )}
                />
                <span className="text-xs text-text-dimmed">v{selectedVersion.version}</span>
                {isCurrent && <Badge variant="extra-small">current</Badge>}
                {selectedVersion.labels.includes("override") && (
                  <Badge variant="extra-small" className="border-amber-500/30 text-amber-400">
                    override
                  </Badge>
                )}
              </div>
            )}
            {selectedVersion && !isCurrent && selectedVersion.source === "code" && (
              <Button
                variant="secondary/small"
                onClick={() => handlePromote(selectedVersion.id)}
                disabled={fetcher.state !== "idle"}
              >
                Promote to current
              </Button>
            )}
            {selectedVersion &&
              selectedVersion.source !== "code" &&
              !selectedVersion.labels.includes("override") && (
                <Button
                  variant="secondary/small"
                  onClick={() =>
                    fetcher.submit(
                      { intent: "reactivateOverride", versionId: selectedVersion.id },
                      { method: "POST" }
                    )
                  }
                  disabled={fetcher.state !== "idle"}
                >
                  Reactivate as override
                </Button>
              )}
            {!overrideVersion && (
              <Button variant="secondary/small" onClick={() => setOverrideDialogOpen(true)}>
                Create Override
              </Button>
            )}
          </div>
        </PageAccessories>
      </NavBar>
      <div>
        <AnimatePresence initial={false}>
          {overrideVersion && (
            <motion.div
              className="flex flex-wrap items-center justify-between gap-2 overflow-hidden border-b border-amber-500/10 bg-amber-500/10 pl-4 pr-2"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
            >
              <span className="py-1.5 text-xs text-amber-300">
                Override v{overrideVersion.version} is active. API calls resolve to this version
                instead of the deployed prompt.
              </span>
              <div className="flex items-center gap-2 py-1.5">
                <Button
                  variant="tertiary/small"
                  className="border-amber-300/50 bg-amber-400/10 text-amber-300 group-hover/button:border-amber-400/60 group-hover/button:bg-amber-500/25 group-hover/button:text-amber-200"
                  onClick={() => setOverrideDialogOpen(true)}
                >
                  Edit
                </Button>
                <Button
                  variant="tertiary/small"
                  className="border-amber-300/50 bg-amber-400/10 text-amber-300 group-hover/button:border-amber-400/60 group-hover/button:bg-amber-500/25 group-hover/button:text-amber-200"
                  onClick={() => fetcher.submit({ intent: "removeOverride" }, { method: "POST" })}
                  disabled={fetcher.state !== "idle"}
                >
                  Remove
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <PageBody scrollable={false}>
        <ResizablePanelGroup
          autosaveId="prompt-detail"
          snapshot={resizable?.outer}
          className="h-full max-h-full"
        >
          {/* Main content */}
          <ResizablePanel id="prompt-main" min="400px">
            <ResizablePanelGroup
              autosaveId="prompt-vertical"
              snapshot={resizable?.vertical}
              orientation="vertical"
              className="h-full max-h-full"
            >
              {/* Template panel */}
              <ResizablePanel id="prompt-template" default="250px" min="80px">
                {content ? (
                  <CodeBlock
                    code={content}
                    language="markdown"
                    showLineNumbers={false}
                    showCopyButton={true}
                    showTextWrapping={false}
                    showOpenInModal={true}
                    className="h-full overflow-y-auto border-none p-2 pt-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 [&_pre]:text-sm"
                    maxLines={undefined}
                  />
                ) : (
                  <div className="p-3">
                    <Paragraph variant="small" className="text-text-dimmed">
                      No content
                    </Paragraph>
                  </div>
                )}
              </ResizablePanel>

              <ResizableHandle id="prompt-vertical-handle" />

              {/* Tabs panel */}
              <ResizablePanel id="prompt-tabs" min="100px">
                <div className="grid h-full max-h-full grid-rows-[2.25rem_1fr] overflow-hidden">
                  {/* Tab bar */}
                  <div className="flex items-center justify-between border-b border-grid-dimmed px-3">
                    <TabContainer>
                      <TabButton
                        isActive={contentTab === "generations"}
                        layoutId="prompt-content"
                        onClick={() =>
                          replaceSearch({
                            contentTab: "generations",
                            tab,
                            version: searchValue("version"),
                            period: searchValue("period"),
                            from: searchValue("from"),
                            to: searchValue("to"),
                          })
                        }
                      >
                        Generations
                      </TabButton>
                      <TabButton
                        isActive={contentTab === "metrics"}
                        layoutId="prompt-content"
                        onClick={() =>
                          replaceSearch({
                            contentTab: "metrics",
                            tab,
                            version: searchValue("version"),
                            period: searchValue("period"),
                            from: searchValue("from"),
                            to: searchValue("to"),
                          })
                        }
                      >
                        Metrics
                      </TabButton>
                    </TabContainer>
                    <div className="flex items-center gap-1">
                      <PromptVersionsFilter versions={versions} />
                      <ModelsFilter
                        possibleModels={possibleModels.map((m) => ({ model: m, system: "" }))}
                      />
                      <OperationsFilter possibleOperations={possibleOperations} />
                      <ProvidersFilter possibleProviders={possibleProviders} />
                      <TimeFilter
                        defaultPeriod="7d"
                        labelName="Period"
                        hideLabel
                        valueClassName="text-text-bright"
                        shortcut={{ key: "t" }}
                      />
                    </div>
                  </div>

                  {/* Tab content */}
                  <div className="min-h-0 overflow-hidden">
                    {contentTab === "generations" && (
                      <GenerationsTab
                        promptSlug={prompt.slug}
                        initialGenerations={generations}
                        initialPagination={generationsPagination}
                        selectedSpan={selectedSpan}
                        onSelectSpan={setSelectedSpan}
                        generationsSnapshot={resizable?.generations}
                      />
                    )}

                    {contentTab === "metrics" && (
                      <div className="h-full overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                        <MetricsTab
                          prompt={prompt}
                          organizationId={organizationId}
                          projectId={projectId}
                          environmentId={environmentId}
                          period={period}
                          from={from}
                          to={to}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle id="prompt-sidebar-handle" />

          {/* Sidebar */}
          <ResizablePanel
            id="prompt-sidebar"
            default="380px"
            min="280px"
            max="500px"
            isStaticAtRest
          >
            <div className="grid h-full max-h-full grid-rows-[2rem_1fr] overflow-hidden bg-background-bright">
              {/* Tabs */}
              <div className="overflow-x-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                <TabContainer>
                  <TabButton
                    isActive={tab === "details"}
                    layoutId="prompt-sidebar"
                    onClick={() => replaceSearch({ tab: "details", version: versionParam })}
                    shortcut={{ key: "d" }}
                  >
                    Details
                  </TabButton>
                  <TabButton
                    isActive={tab === "preview"}
                    layoutId="prompt-sidebar"
                    onClick={() => replaceSearch({ tab: "preview", version: versionParam })}
                    shortcut={{ key: "p" }}
                  >
                    Preview
                  </TabButton>
                  <TabButton
                    isActive={tab === "versions"}
                    layoutId="prompt-sidebar"
                    onClick={() => replaceSearch({ tab: "versions", version: versionParam })}
                    shortcut={{ key: "v" }}
                  >
                    Versions
                  </TabButton>
                </TabContainer>
              </div>

              {/* Tab content */}
              <div
                className={cn(
                  "overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600",
                  tab === "versions" ? "py-0" : "px-3 py-3"
                )}
              >
                {tab === "details" && (
                  <DetailsTab prompt={prompt} selectedVersion={selectedVersion} />
                )}
                {tab === "preview" && <PreviewTab prompt={prompt} content={content} />}
                {tab === "versions" && (
                  <VersionsTab
                    versions={versions}
                    selectedVersion={selectedVersion}
                    onSelectVersion={switchVersion}
                  />
                )}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
      <OverrideDialog
        open={overrideDialogOpen}
        onOpenChange={setOverrideDialogOpen}
        prompt={prompt}
        content={
          overrideVersion
            ? getVersionContent(
                versions.find((v) => v.id === overrideVersion.id) ?? { textContent: null }
              )
            : content
        }
        isEditingOverride={!!overrideVersion}
        currentOverrideModel={
          overrideVersion ? versions.find((v) => v.id === overrideVersion.id)?.model ?? null : null
        }
        onSave={(textContent, commitMessage, model) => {
          const intent = overrideVersion ? "updateOverride" : "saveVersion";
          fetcher.submit({ intent, textContent, commitMessage, model }, { method: "POST" });
          setOverrideDialogOpen(false);
        }}
      />
    </PageContainer>
  );
}

// ─── Override Dialog ─────────────────────────────────────

function OverrideDialog({
  open,
  onOpenChange,
  prompt,
  content,
  isEditingOverride,
  currentOverrideModel,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: {
    slug: string;
    defaultModel: string | null;
    defaultConfig: unknown;
    variableSchema: unknown;
  };
  content: string;
  isEditingOverride: boolean;
  currentOverrideModel?: string | null;
  onSave: (textContent: string, commitMessage: string, model: string) => void;
}) {
  const effectiveModel = currentOverrideModel ?? prompt.defaultModel ?? "";
  const [editedContent, setEditedContent] = useState(content);
  const [commitMessage, setCommitMessage] = useState("");
  const [model, setModel] = useState(effectiveModel);

  // Reset when dialog opens
  useEffect(() => {
    if (open) {
      setEditedContent(content);
      setCommitMessage("");
      setModel(currentOverrideModel ?? prompt.defaultModel ?? "");
    }
  }, [open, content, currentOverrideModel, prompt.defaultModel]);

  const variableFields = prompt.variableSchema ? extractVariableFields(prompt.variableSchema) : [];

  // Extract variables used in the template
  const templateVars = new Set<string>();
  editedContent.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    templateVars.add(key);
    return "";
  });
  editedContent.replace(/\{\{#(\w+)\}\}/g, (_m, key) => {
    templateVars.add(key);
    return "";
  });

  // Check for schema mismatches
  const schemaVarNames = new Set(variableFields.map((f) => f.name));
  const undefinedVars = [...templateVars].filter((v) => !schemaVarNames.has(v));
  const unusedVars = variableFields.filter((f) => f.required && !templateVars.has(f.name));

  const hasChanges = editedContent !== content || model !== effectiveModel;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col !gap-0 overflow-hidden px-0 pt-0 md:max-w-4xl lg:max-w-6xl">
        <DialogHeader className="px-4 py-2.5">
          {isEditingOverride ? "Edit override" : "Create override"}
        </DialogHeader>

        <ResizablePanelGroup
          orientation="horizontal"
          className="-mx-3 w-auto flex-1 border-b border-t border-grid-dimmed"
        >
          {/* Editor */}
          <ResizablePanel id="override-editor" min="300px">
            <TextEditor
              className="h-full"
              autoFocus
              defaultValue={editedContent}
              onChange={setEditedContent}
              showCopyButton
            />
          </ResizablePanel>

          <ResizableHandle id="override-handle" />

          {/* Right panel: properties */}
          <ResizablePanel id="override-sidebar" min="220px" default="280px" max="360px">
            <div className="h-full overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Header3>Override settings</Header3>
                  <InputGroup>
                    <Label variant="small">Commit message</Label>
                    <Input
                      variant="small"
                      placeholder="What changed? (optional)"
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                    />
                  </InputGroup>
                  <InputGroup>
                    <Label variant="small">Model</Label>
                    <Input
                      variant="small"
                      placeholder={prompt.defaultModel ?? "No default"}
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    />
                    <Hint>Override the default model for this version</Hint>
                  </InputGroup>
                </div>

                {/* Variable schema (read-only) */}
                {variableFields.length > 0 && (
                  <div className="space-y-1.5 border-t border-grid-dimmed pt-3">
                    <Label variant="small">Variables (from code)</Label>
                    <div className="space-y-1">
                      {variableFields.map((f) => (
                        <div key={f.name} className="flex items-center gap-1.5 text-xs">
                          <code className="rounded bg-charcoal-750 px-1 py-0.5 text-text-bright">
                            {f.name}
                          </code>
                          <span className="text-text-dimmed">{f.type}</span>
                          {f.required && (
                            <Badge
                              variant="extra-small"
                              className="border-amber-500/30 text-amber-400"
                            >
                              required
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Validation warnings */}
                {(undefinedVars.length > 0 || unusedVars.length > 0) && (
                  <div className="space-y-2 border-t border-grid-dimmed pt-3">
                    {undefinedVars.length > 0 && (
                      <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-300">
                        <span className="font-medium">Undefined variables:</span>{" "}
                        {undefinedVars.map((v) => (
                          <code
                            key={v}
                            className="mx-0.5 rounded bg-amber-500/10 px-1"
                          >{`{{${v}}}`}</code>
                        ))}
                      </div>
                    )}
                    {unusedVars.length > 0 && (
                      <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-300">
                        <span className="font-medium">Required but missing:</span>{" "}
                        {unusedVars.map((v) => (
                          <code key={v.name} className="mx-0.5 rounded bg-amber-500/10 px-1">
                            {v.name}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <DialogClose asChild>
            <Button variant="tertiary/medium">Cancel</Button>
          </DialogClose>
          <Button
            variant="primary/medium"
            disabled={!hasChanges}
            onClick={() => onSave(editedContent, commitMessage, model)}
          >
            {isEditingOverride ? "Save override" : "Create override"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Details Tab ─────────────────────────────────────────

function DetailsTab({
  prompt,
  selectedVersion,
}: {
  prompt: ReturnType<typeof useTypedLoaderData<typeof loader>>["prompt"];
  selectedVersion?: VersionData;
}) {
  const effectiveModel = selectedVersion?.model ?? prompt.defaultModel;
  return (
    <div className="space-y-4">
      <Property.Table>
        <Property.Item>
          <Property.Label>Slug</Property.Label>
          <Property.Value>
            <code className="text-sm">{prompt.slug}</code>
          </Property.Value>
        </Property.Item>
        {prompt.description && (
          <Property.Item>
            <Property.Label>Description</Property.Label>
            <Property.Value>{prompt.description}</Property.Value>
          </Property.Item>
        )}
        {effectiveModel && (
          <Property.Item>
            <Property.Label>Model</Property.Label>
            <Property.Value>{effectiveModel}</Property.Value>
          </Property.Item>
        )}
        {prompt.defaultConfig && (
          <Property.Item>
            <Property.Label className="mb-1.5">Config</Property.Label>
            <Property.Value>
              <CodeBlock
                code={JSON.stringify(prompt.defaultConfig, null, 2)}
                maxLines={10}
                showLineNumbers={false}
              />
            </Property.Value>
          </Property.Item>
        )}
        {prompt.filePath && (
          <Property.Item>
            <Property.Label>Source</Property.Label>
            <Property.Value>
              <code className="text-sm">
                {prompt.filePath}
                {prompt.exportName ? ` (${prompt.exportName})` : ""}
              </code>
            </Property.Value>
          </Property.Item>
        )}
        {prompt.tags.length > 0 && (
          <Property.Item>
            <Property.Label>Tags</Property.Label>
            <Property.Value>
              <div className="flex flex-wrap gap-1">
                {prompt.tags.map((tag) => (
                  <Badge key={tag} variant="extra-small">
                    {tag}
                  </Badge>
                ))}
              </div>
            </Property.Value>
          </Property.Item>
        )}
      </Property.Table>

      {prompt.variableSchema && (
        <div className="space-y-2">
          <Header3>Variable schema</Header3>
          <CodeBlock
            code={JSON.stringify(prompt.variableSchema, null, 2)}
            maxLines={20}
            showLineNumbers={false}
            showCopyButton
          />
        </div>
      )}
    </div>
  );
}

// ─── Preview Tab ─────────────────────────────────────────

function PreviewTab({
  prompt,
  content,
}: {
  prompt: ReturnType<typeof useTypedLoaderData<typeof loader>>["prompt"];
  content: string;
}) {
  const variableFields = prompt.variableSchema ? extractVariableFields(prompt.variableSchema) : [];
  const [testVariables, setTestVariables] = useState<Record<string, string>>(() =>
    Object.fromEntries(variableFields.map((f) => [f.name, ""]))
  );
  const hasTestValues = Object.values(testVariables).some((v) => v.length > 0);
  const previewText = hasTestValues ? compileTemplatePreview(content, testVariables) : null;

  return (
    <div className="space-y-4">
      {variableFields.length > 0 ? (
        <>
          <div className="space-y-3">
            <div>
              <Header3 className="mb-1">Variables</Header3>
              <Paragraph variant="small">
                Fill in values to preview your resolved prompt template.
              </Paragraph>
            </div>
            {variableFields.map((field, index) => (
              <InputGroup className="max-w-full" key={field.name}>
                <Label variant="small" required={field.required}>
                  {field.name}
                </Label>
                {field.enumValues ? (
                  <select
                    autoFocus={index === 0}
                    className="h-6 w-full rounded border border-charcoal-650 bg-background-bright px-1 text-xs text-text-bright focus:border-indigo-500 focus:outline-none"
                    value={testVariables[field.name] ?? ""}
                    onChange={(e) =>
                      setTestVariables((prev) => ({
                        ...prev,
                        [field.name]: e.target.value,
                      }))
                    }
                  >
                    <option value="">Select…</option>
                    {field.enumValues.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : field.isLongText ? (
                  <TextArea
                    autoFocus={index === 0}
                    rows={3}
                    className="w-full text-sm"
                    placeholder={field.placeholder}
                    value={testVariables[field.name] ?? ""}
                    onChange={(e) =>
                      setTestVariables((prev) => ({
                        ...prev,
                        [field.name]: e.target.value,
                      }))
                    }
                  />
                ) : (
                  <Input
                    autoFocus={index === 0}
                    variant="small"
                    placeholder={field.placeholder}
                    value={testVariables[field.name] ?? ""}
                    onChange={(e) =>
                      setTestVariables((prev) => ({
                        ...prev,
                        [field.name]: e.target.value,
                      }))
                    }
                  />
                )}
                {field.description && <Hint>{field.description}</Hint>}
              </InputGroup>
            ))}
          </div>

          {previewText && (
            <div className="space-y-1.5">
              <Header3>Resolved output</Header3>
              <div className="overflow-auto rounded border border-grid-bright bg-background-dimmed p-3">
                <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-text-bright">
                  {previewText}
                </pre>
              </div>
            </div>
          )}
        </>
      ) : (
        content && (
          <>
            <Header3>Resolved output</Header3>
            <div className="overflow-auto rounded border border-grid-bright bg-background-dimmed p-3">
              <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-text-bright">
                {content}
              </pre>
            </div>
          </>
        )
      )}
    </div>
  );
}

// ─── Generations Tab ─────────────────────────────────────

function GenerationsTab({
  promptSlug,
  initialGenerations,
  initialPagination,
  selectedSpan,
  onSelectSpan,
  generationsSnapshot,
}: {
  promptSlug: string;
  initialGenerations: GenerationRow[];
  initialPagination: { next?: string };
  selectedSpan: { runId: string; spanId: string } | null;
  onSelectSpan: (span: { runId: string; spanId: string } | null) => void;
  generationsSnapshot?: ResizableSnapshot;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { value: searchValue } = useSearchParams();
  const listRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const fetcher = useFetcher<{ generations: GenerationRow[]; pagination: { next?: string } }>();
  const pollFetcher = useFetcher<{ generations: GenerationRow[]; pagination: { next?: string } }>();

  // Accumulated generations state
  const [generations, setGenerations] = useState<GenerationRow[]>(initialGenerations);
  const [nextCursor, setNextCursor] = useState<string | undefined>(initialPagination.next);
  const [newGenerationCount, setNewGenerationCount] = useState(0);

  // Build the resource URL for fetches
  const resourcePath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
    environment.slug
  }/prompts/${encodeURIComponent(promptSlug)}/generations`;

  // Track filter state to reset on change
  const { values: filterValues } = useSearchParams();
  const models = filterValues("models").filter((v) => v !== "");
  const operations = filterValues("operations").filter((v) => v !== "");
  const providers = filterValues("providers").filter((v) => v !== "");

  const versionFilters = filterValues("versions").filter((v) => v !== "");
  const filterKey = `${versionFilters.join(",")}-${searchValue("period") ?? "7d"}-${
    searchValue("from") ?? ""
  }-${searchValue("to") ?? ""}-${models.join(",")}-${operations.join(",")}-${providers.join(",")}`;
  const prevFilterKeyRef = useRef(filterKey);

  // Reset when filters change (loader re-runs with new initial data)
  useEffect(() => {
    if (prevFilterKeyRef.current !== filterKey) {
      prevFilterKeyRef.current = filterKey;
      setGenerations(initialGenerations);
      setNextCursor(initialPagination.next);
      setNewGenerationCount(0);
    }
  }, [filterKey, initialGenerations, initialPagination.next]);

  // Also reset if initialGenerations change identity (page navigation)
  const initialGenRef = useRef(initialGenerations);
  useEffect(() => {
    if (initialGenRef.current !== initialGenerations) {
      initialGenRef.current = initialGenerations;
      setGenerations(initialGenerations);
      setNextCursor(initialPagination.next);
      setNewGenerationCount(0);
    }
  }, [initialGenerations, initialPagination.next]);

  // Append fetched rows when fetcher completes
  useEffect(() => {
    if (fetcher.data && fetcher.state === "idle") {
      setGenerations((prev) => {
        const existingIds = new Set(prev.map((g) => g.span_id));
        const newRows = fetcher.data!.generations.filter((g) => !existingIds.has(g.span_id));
        return newRows.length > 0 ? [...prev, ...newRows] : prev;
      });
      setNextCursor(fetcher.data.pagination.next);
    }
  }, [fetcher.data, fetcher.state]);

  // Poll for new generations periodically (also on focus/visibility)
  useInterval({
    interval: 10_000,
    onLoad: false,
    callback: () => {
      if (pollFetcher.state !== "idle") return;
      const params = new URLSearchParams();
      for (const v of versionFilters) params.append("versions", v);
      params.set("period", searchValue("period") ?? "7d");
      const from = searchValue("from");
      const to = searchValue("to");
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      for (const m of models) params.append("models", m);
      for (const o of operations) params.append("operations", o);
      for (const p of providers) params.append("providers", p);
      pollFetcher.load(`${resourcePath}?${params.toString()}`);
    },
  });

  // Check poll results for new generations — only react to new poll data, not generation list changes
  const lastPollDataRef = useRef(pollFetcher.data);
  useEffect(() => {
    if (
      pollFetcher.data &&
      pollFetcher.state === "idle" &&
      pollFetcher.data !== lastPollDataRef.current
    ) {
      lastPollDataRef.current = pollFetcher.data;
      const existingIds = new Set(generations.map((g) => g.span_id));
      const newCount = pollFetcher.data.generations.filter(
        (g) => !existingIds.has(g.span_id)
      ).length;
      setNewGenerationCount(newCount);
    }
  }, [pollFetcher.data, pollFetcher.state, generations]);

  const handleRefreshGenerations = useCallback(() => {
    // Prepend new generations from the poll data
    if (pollFetcher.data) {
      setGenerations((prev) => {
        const existingIds = new Set(prev.map((g) => g.span_id));
        const newRows = pollFetcher.data!.generations.filter((g) => !existingIds.has(g.span_id));
        return newRows.length > 0 ? [...newRows, ...prev] : prev;
      });
    }
    setNewGenerationCount(0);
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [pollFetcher.data]);

  const handleLoadMore = useCallback(() => {
    if (!nextCursor || fetcher.state !== "idle") return;

    const params = new URLSearchParams();
    for (const v of versionFilters) params.append("versions", v);
    params.set("period", searchValue("period") ?? "7d");
    const from = searchValue("from");
    const to = searchValue("to");
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    for (const m of models) params.append("models", m);
    for (const o of operations) params.append("operations", o);
    for (const p of providers) params.append("providers", p);
    params.set("cursor", nextCursor);
    fetcher.load(`${resourcePath}?${params.toString()}`);
  }, [
    nextCursor,
    fetcher,
    searchValue,
    resourcePath,
    versionFilters,
    models,
    operations,
    providers,
  ]);

  // Debounced loading spinner
  const isLoadingMore = fetcher.state === "loading";
  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    if (!isLoadingMore) {
      setShowSpinner(false);
      return;
    }
    const timer = setTimeout(() => setShowSpinner(true), 200);
    return () => clearTimeout(timer);
  }, [isLoadingMore]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (!nextCursor || isLoadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          handleLoadMore();
        }
      },
      { threshold: 0.1 }
    );

    const currentRef = loadMoreRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [nextCursor, isLoadingMore, handleLoadMore]);

  // Keyboard navigation
  const selectedIndex = selectedSpan
    ? generations.findIndex((g) => g.span_id === selectedSpan.spanId)
    : -1;

  const selectByIndex = useCallback(
    (index: number) => {
      const gen = generations[index];
      if (gen) {
        onSelectSpan({ runId: gen.run_id, spanId: gen.span_id });
        const items = listRef.current?.querySelectorAll("[data-generation-item]");
        items?.[index]?.scrollIntoView({ block: "nearest" });
      }
    },
    [generations, onSelectSpan]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const next = selectedIndex < generations.length - 1 ? selectedIndex + 1 : 0;
        selectByIndex(next);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const prev = selectedIndex > 0 ? selectedIndex - 1 : generations.length - 1;
        selectByIndex(prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIndex, generations.length, selectByIndex]);

  if (generations.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <InfoPanel
          title="No generations yet"
          icon={AIPromptsIcon}
          iconClassName="text-aiPrompts"
          panelClassName="max-w-md"
        >
          <Paragraph variant="small">
            Generations appear here when this prompt version is resolved inside a task using{" "}
            <InlineCode variant="small">prompt.resolve()</InlineCode> with an AI SDK call.
          </Paragraph>
          <Paragraph variant="small">
            Try adjusting the time period filter or switching to a different version.
          </Paragraph>
        </InfoPanel>
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      autosaveId="prompt-generations"
      snapshot={generationsSnapshot}
      className="h-full"
    >
      {/* Span list */}
      <ResizablePanel id="prompt-gen-list" min="200px">
        <div
          ref={listRef}
          className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          {newGenerationCount > 0 && (
            <div className="sticky top-0 z-10 flex items-center justify-center gap-2 border-b border-grid-dimmed bg-background-bright px-3 py-1.5">
              <span className="text-xs text-text-dimmed">
                {newGenerationCount} new {newGenerationCount === 1 ? "generation" : "generations"}
              </span>
              <Button
                variant="minimal/small"
                onClick={handleRefreshGenerations}
                LeadingIcon={ArrowPathIcon}
              >
                Refresh
              </Button>
            </div>
          )}
          {generations.map((gen, i) => {
            const isSelected = selectedSpan?.spanId === gen.span_id;
            const runPath = v3RunSpanPath(
              organization,
              project,
              environment,
              { friendlyId: gen.run_id },
              { spanId: gen.span_id }
            );
            return (
              <div
                key={`${gen.run_id}-${gen.span_id}-${i}`}
                data-generation-item
                onClick={() => onSelectSpan({ runId: gen.run_id, spanId: gen.span_id })}
                className={`cursor-pointer border-b border-grid-dimmed px-3 py-2 text-xs transition last:border-0 ${
                  isSelected ? "bg-indigo-500/10" : "hover:bg-charcoal-850"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-bright">
                    {gen.operation_id || gen.task_identifier}
                  </span>
                  <span className="text-text-dimmed">{gen.start_time}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between">
                  <div className="flex items-center gap-3 text-text-dimmed">
                    <span className="text-charcoal-400">v{gen.prompt_version}</span>
                    <span>{gen.response_model}</span>
                    <span>{gen.input_tokens + gen.output_tokens} tokens</span>
                    <span>{formatCost(gen.total_cost)}</span>
                    <span>{Math.round(gen.duration_ms)}ms</span>
                  </div>
                  <TextLink to={runPath} className="text-xs" onClick={(e) => e.stopPropagation()}>
                    View run
                  </TextLink>
                </div>
              </div>
            );
          })}

          {/* Infinite scroll sentinel */}
          <div ref={loadMoreRef} className="h-px" />
          {showSpinner && (
            <div className="flex items-center justify-center py-3">
              <Spinner className="size-4" />
            </div>
          )}
        </div>
      </ResizablePanel>

      <ResizableHandle id="prompt-gen-handle" />

      {/* Span inspector */}
      <ResizablePanel id="prompt-gen-inspector" default="40%" min="200px" isStaticAtRest>
        {selectedSpan ? (
          <SpanView runParam={selectedSpan.runId} spanId={selectedSpan.spanId} />
        ) : (
          <div className="flex h-full items-center justify-center bg-background-bright">
            <Paragraph variant="small" className="text-text-dimmed">
              Select a generation to inspect
            </Paragraph>
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  if (cost === 0) return "$0";
  return `$${cost.toFixed(6)}`;
}

// ─── Metrics Tab ─────────────────────────────────────────

function MetricsTab({
  prompt,
  organizationId,
  projectId,
  environmentId,
  period,
  from,
  to,
}: {
  prompt: { slug: string };
  organizationId: string;
  projectId: string;
  environmentId: string;
  period: string;
  from: string | null;
  to: string | null;
}) {
  const { values: filterValues } = useSearchParams();
  const versionFilters = filterValues("versions")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const models = filterValues("models").filter((v) => v !== "");
  const operations = filterValues("operations").filter((v) => v !== "");
  const providers = filterValues("providers").filter((v) => v !== "");

  const widgetProps = {
    organizationId,
    projectId,
    environmentId,
    scope: "environment" as const,
    period,
    from,
    to,
    promptSlugs: [prompt.slug],
    promptVersions: versionFilters.length > 0 ? versionFilters : undefined,
    responseModels: models.length > 0 ? models : undefined,
    operations: operations.length > 0 ? operations : undefined,
    providers: providers.length > 0 ? providers : undefined,
  };

  return (
    <div className="space-y-4">
      {/* Summary big numbers */}
      <div className="grid grid-cols-4 gap-2">
        <div className="h-32">
          <MetricWidget
            widgetKey={`prompt-${prompt.slug}-generations`}
            title="Total"
            query={`SELECT count() AS generations FROM llm_metrics WHERE 1=1`}
            config={{
              type: "bignumber",
              column: "generations",
              aggregation: "sum",
              abbreviate: true,
            }}
            {...widgetProps}
          />
        </div>
        <div className="h-32">
          <MetricWidget
            widgetKey={`prompt-${prompt.slug}-tokens`}
            title="Avg input tokens"
            query={`SELECT round(avg(input_tokens)) AS avg_input FROM llm_metrics WHERE 1=1`}
            config={{
              type: "bignumber",
              column: "avg_input",
              aggregation: "avg",
              abbreviate: true,
            }}
            {...widgetProps}
          />
        </div>
        <div className="h-32">
          <MetricWidget
            widgetKey={`prompt-${prompt.slug}-cost`}
            title="Avg input cost"
            query={`SELECT avg(input_cost) AS avg_cost FROM llm_metrics WHERE 1=1`}
            config={{
              type: "bignumber",
              column: "avg_cost",
              aggregation: "avg",
              abbreviate: false,
            }}
            {...widgetProps}
          />
        </div>
        <div className="h-32">
          <MetricWidget
            widgetKey={`prompt-${prompt.slug}-latency`}
            title="Avg latency"
            query={`SELECT round(avg(duration) / 1000000, 1) AS avg_ms FROM llm_metrics WHERE 1=1`}
            config={{
              type: "bignumber",
              column: "avg_ms",
              aggregation: "avg",
              abbreviate: false,
              suffix: "ms",
            }}
            {...widgetProps}
          />
        </div>
      </div>

      {/* Version performance */}
      <VersionPerformanceSection
        promptSlug={prompt.slug}
        organizationId={organizationId}
        projectId={projectId}
        environmentId={environmentId}
        period={period}
        from={from}
        to={to}
      />
    </div>
  );
}

// ─── Version Performance Section ─────────────────────────

function VersionPerformanceSection({
  promptSlug,
  organizationId,
  projectId,
  environmentId,
  period,
  from,
  to,
}: {
  promptSlug: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  period: string;
  from: string | null;
  to: string | null;
}) {
  const { values: filterValues } = useSearchParams();
  const versionFilters = filterValues("versions")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const models = filterValues("models").filter((v) => v !== "");
  const operations = filterValues("operations").filter((v) => v !== "");
  const providers = filterValues("providers").filter((v) => v !== "");

  const widgetProps = {
    organizationId,
    projectId,
    environmentId,
    scope: "environment" as const,
    period,
    from,
    to,
    promptSlugs: [promptSlug],
    promptVersions: versionFilters.length > 0 ? versionFilters : undefined,
    responseModels: models.length > 0 ? models : undefined,
    operations: operations.length > 0 ? operations : undefined,
    providers: providers.length > 0 ? providers : undefined,
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {/* Row 1: Latency + TTFC */}
        <div className="h-96">
          <MetricWidget
            widgetKey={`prompt-${promptSlug}-perf-latency`}
            title="Latency p50 / p95"
            query={`SELECT timeBucket(), round(quantile(0.5)(duration) / 1000000, 1) AS p50, round(quantile(0.95)(duration) / 1000000, 1) AS p95 FROM llm_metrics WHERE 1=1 GROUP BY timeBucket ORDER BY timeBucket`}
            config={{
              type: "chart",
              chartType: "line",
              xAxisColumn: "timebucket",
              yAxisColumns: ["p50", "p95"],
              groupByColumn: null,
              stacked: false,
              sortByColumn: null,
              sortDirection: "asc",
              aggregation: "avg",
            }}
            {...widgetProps}
          />
        </div>
        <div className="h-96">
          <MetricWidget
            widgetKey={`prompt-${promptSlug}-perf-ttfc`}
            title="TTFC p50 / p95"
            query={`SELECT timeBucket(), round(quantile(0.5)(ms_to_first_chunk), 1) AS p50, round(quantile(0.95)(ms_to_first_chunk), 1) AS p95 FROM llm_metrics WHERE ms_to_first_chunk > 0 GROUP BY timeBucket ORDER BY timeBucket`}
            config={{
              type: "chart",
              chartType: "line",
              xAxisColumn: "timebucket",
              yAxisColumns: ["p50", "p95"],
              groupByColumn: null,
              stacked: false,
              sortByColumn: null,
              sortDirection: "asc",
              aggregation: "avg",
            }}
            {...widgetProps}
          />
        </div>
        {/* Row 2: Input tokens + Input cost */}
        <div className="h-96">
          <MetricWidget
            widgetKey={`prompt-${promptSlug}-perf-input-tokens`}
            title="Input tokens p50 / p95"
            query={`SELECT timeBucket(), round(quantile(0.5)(input_tokens)) AS p50, round(quantile(0.95)(input_tokens)) AS p95 FROM llm_metrics WHERE 1=1 GROUP BY timeBucket ORDER BY timeBucket`}
            config={{
              type: "chart",
              chartType: "line",
              xAxisColumn: "timebucket",
              yAxisColumns: ["p50", "p95"],
              groupByColumn: null,
              stacked: false,
              sortByColumn: null,
              sortDirection: "asc",
              aggregation: "avg",
            }}
            {...widgetProps}
          />
        </div>
        <div className="h-96">
          <MetricWidget
            widgetKey={`prompt-${promptSlug}-perf-input-cost`}
            title="Input cost per 1k tokens (p50 / p95)"
            query={`SELECT timeBucket(), prettyFormat(quantile(0.5)(input_cost / input_tokens * 1000), 'costInDollars') AS p50, prettyFormat(quantile(0.95)(input_cost / input_tokens * 1000), 'costInDollars') AS p95 FROM llm_metrics WHERE input_tokens > 0 GROUP BY timeBucket ORDER BY timeBucket`}
            config={{
              type: "chart",
              chartType: "line",
              xAxisColumn: "timebucket",
              yAxisColumns: ["p50", "p95"],
              groupByColumn: null,
              stacked: false,
              sortByColumn: null,
              sortDirection: "asc",
              aggregation: "avg",
            }}
            {...widgetProps}
          />
        </div>
        {/* Row 3: Output tokens + Output cost */}
        <div className="h-96">
          <MetricWidget
            widgetKey={`prompt-${promptSlug}-perf-output-tokens`}
            title="Output tokens p50 / p95"
            query={`SELECT timeBucket(), round(quantile(0.5)(output_tokens)) AS p50, round(quantile(0.95)(output_tokens)) AS p95 FROM llm_metrics WHERE 1=1 GROUP BY timeBucket ORDER BY timeBucket`}
            config={{
              type: "chart",
              chartType: "line",
              xAxisColumn: "timebucket",
              yAxisColumns: ["p50", "p95"],
              groupByColumn: null,
              stacked: false,
              sortByColumn: null,
              sortDirection: "asc",
              aggregation: "avg",
            }}
            {...widgetProps}
          />
        </div>
        <div className="h-96">
          <MetricWidget
            widgetKey={`prompt-${promptSlug}-perf-output-cost`}
            title="Output cost per 1k tokens (p50 / p95)"
            query={`SELECT timeBucket(), prettyFormat(quantile(0.5)(output_cost / output_tokens * 1000), 'costInDollars') AS p50, prettyFormat(quantile(0.95)(output_cost / output_tokens * 1000), 'costInDollars') AS p95 FROM llm_metrics WHERE output_tokens > 0 GROUP BY timeBucket ORDER BY timeBucket`}
            config={{
              type: "chart",
              chartType: "line",
              xAxisColumn: "timebucket",
              yAxisColumns: ["p50", "p95"],
              groupByColumn: null,
              stacked: false,
              sortByColumn: null,
              sortDirection: "asc",
              aggregation: "avg",
            }}
            {...widgetProps}
          />
        </div>
      </div>

      <div className="h-48">
        <MetricWidget
          widgetKey={`prompt-${promptSlug}-perf-versions-table`}
          title="Version summary"
          query={`SELECT prompt_version, count() AS calls, round(avg(input_tokens)) AS avg_input_tokens, round(avg(output_tokens)) AS avg_output_tokens, prettyFormat(avg(total_cost), 'costInDollars') AS avg_total_cost, round(quantile(0.5)(duration) / 1000000, 1) AS p50_latency_ms, round(quantile(0.95)(duration) / 1000000, 1) AS p95_latency_ms FROM llm_metrics WHERE 1=1 GROUP BY prompt_version ORDER BY prompt_version DESC`}
          config={{ type: "table", prettyFormatting: true, sorting: [] }}
          {...widgetProps}
        />
      </div>
    </div>
  );
}

// ─── Prompt Versions Filter ──────────────────────────────

function PromptVersionsFilter({ versions }: { versions: VersionData[] }) {
  const { values, replace, del } = useSearchParams();
  const selected = values("versions");

  const handleChange = (newValues: string[]) => {
    replace({ versions: newValues });
  };

  if (selected.length === 0 || selected.every((v) => v === "")) {
    return (
      <SelectProvider value={[]} setValue={handleChange} virtualFocus={true}>
        <SelectTrigger
          icon={
            <svg className="size-4">
              <use xlinkHref={`${tablerSpritePath}#tabler-file-text-ai`} />
            </svg>
          }
          variant="secondary/small"
          tooltipTitle="Filter by version"
          shortcut={{ key: "e" }}
        >
          <span className="ml-0.5">Versions</span>
        </SelectTrigger>
        <SelectPopover className="min-w-0 max-w-[min(240px,var(--popover-available-width))]">
          <SelectList>
            {versions.map((v) => (
              <SelectItem key={v.version} value={String(v.version)}>
                v{v.version}
                {v.labels.includes("current") ? " (current)" : ""}
                {v.labels.includes("override") ? " (override)" : ""}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopover>
      </SelectProvider>
    );
  }

  const summary = selected.length === 1 ? `v${selected[0]}` : `${selected.length} versions`;

  return (
    <SelectProvider value={selected} setValue={handleChange} virtualFocus={true}>
      <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
        <AppliedFilter
          label="Version"
          icon={
            <svg className="size-4">
              <use xlinkHref={`${tablerSpritePath}#tabler-file-text-ai`} />
            </svg>
          }
          value={summary}
          onRemove={() => del(["versions"])}
          variant="secondary/small"
        />
      </Ariakit.Select>
      <SelectPopover className="min-w-0 max-w-[min(240px,var(--popover-available-width))]">
        <SelectList>
          {versions.map((v) => (
            <SelectItem key={v.version} value={String(v.version)}>
              v{v.version}
              {v.labels.includes("current") ? " (current)" : ""}
              {v.labels.includes("override") ? " (override)" : ""}
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

// ─── Versions Tab ────────────────────────────────────────

function VersionsTab({
  versions,
  selectedVersion,
  onSelectVersion,
}: {
  versions: VersionData[];
  selectedVersion: VersionData | undefined;
  onSelectVersion: (version: number) => void;
}) {
  return (
    <div className="divide-y divide-grid-dimmed border-b border-grid-dimmed">
      {versions.map((v) => {
        const isSelected = selectedVersion?.id === v.id;
        const isCurrent = v.labels.includes("current");
        const isLatest = v.labels.includes("latest");
        const isOverride = v.labels.includes("override");

        return (
          <div
            key={v.id}
            onClick={() => onSelectVersion(v.version)}
            className={cn(
              "flex cursor-pointer items-center gap-3 px-3 py-3 text-sm transition",
              isSelected ? "bg-indigo-500/10 hover:bg-indigo-500/[0.07]" : "hover:bg-charcoal-750"
            )}
          >
            <RadioButtonCircle checked={isSelected} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    isOverride ? "bg-amber-400" : isCurrent ? "bg-green-500" : "bg-charcoal-600"
                  )}
                />
                <span className="font-medium text-text-bright">v{v.version}</span>
                {isOverride && (
                  <Badge variant="extra-small" className="border-amber-500/30 text-amber-400">
                    override
                  </Badge>
                )}
                {isCurrent && <Badge variant="extra-small">current</Badge>}
                {isLatest && !isCurrent && <Badge variant="extra-small">latest</Badge>}
                <span
                  className={cn(
                    "text-xs",
                    v.source !== "code" ? "text-amber-400" : "text-text-dimmed"
                  )}
                >
                  {v.source}
                </span>
              </div>
              {(v.model || v.commitMessage) && (
                <div className="flex items-center gap-1.5 truncate text-xs text-text-dimmed">
                  {v.model && <span>{v.model}</span>}
                  {v.model && v.commitMessage && <span className="text-charcoal-600">/</span>}
                  {v.commitMessage && <span className="truncate">{v.commitMessage}</span>}
                </div>
              )}
            </div>
            <span className="shrink-0 text-xs text-text-dimmed">
              <DateTime date={v.createdAt} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

const MAX_DESCRIPTION_PREVIEW = 80;

function PromptCopyPopover({
  slug,
  friendlyId,
  description,
}: {
  slug: string;
  friendlyId: string;
  description: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="-ml-1.5 flex items-center gap-1 rounded py-1.5 pl-2 pr-1.5 font-mono text-xs text-text-dimmed transition focus-custom hover:bg-charcoal-750 hover:text-text-bright">
        {slug}
        <ChevronUpDownIcon className="size-4 text-charcoal-500" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex min-w-0 flex-col p-1"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const el = e.currentTarget as HTMLElement;
          el.style.pointerEvents = "none";
          requestAnimationFrame(() => {
            el.style.pointerEvents = "";
          });
        }}
      >
        <CopyPopoverItem label="Copy slug" value={slug} onCopied={() => setOpen(false)} />
        <CopyPopoverItem
          label="Copy friendly ID"
          value={friendlyId}
          onCopied={() => setOpen(false)}
        />
        {description && (
          <CopyPopoverItem
            label="Copy description"
            value={description}
            preview={
              description.length > MAX_DESCRIPTION_PREVIEW
                ? description.slice(0, MAX_DESCRIPTION_PREVIEW) + "…"
                : description
            }
            onCopied={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function CopyPopoverItem({
  label,
  value,
  preview,
  onCopied,
}: {
  label: string;
  value: string;
  preview?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      onCopied?.();
    }, 600);
  };

  return (
    <SimpleTooltip
      button={
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition",
            copied
              ? "text-green-500"
              : "text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"
          )}
        >
          {copied ? (
            <ClipboardCheckIcon className="size-3.5 shrink-0" />
          ) : (
            <ClipboardIcon className="size-3.5 shrink-0" />
          )}
          {label}
        </button>
      }
      content={<span className="max-w-64 break-all font-mono text-xs">{preview ?? value}</span>}
      side="right"
      disableHoverableContent
      asChild
    />
  );
}
