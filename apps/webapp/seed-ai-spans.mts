import { trail } from "agentcrumbs"; // @crumbs
const crumb = trail("webapp"); // @crumbs
import { prisma } from "./app/db.server";
import { createOrganization } from "./app/models/organization.server";
import { createProject } from "./app/models/project.server";
import { ClickHouse } from "@internal/clickhouse";
import type { TaskEventV2Input, LlmUsageV1Input } from "@internal/clickhouse";
import {
  generateTraceId,
  generateSpanId,
} from "./app/v3/eventRepository/common.server";
import {
  enrichCreatableEvents,
  setLlmPricingRegistry,
} from "./app/v3/utils/enrichCreatableEvents.server";
import { ModelPricingRegistry, seedLlmPricing } from "@internal/llm-pricing";
import { nanoid } from "nanoid";
import { unflattenAttributes } from "@trigger.dev/core/v3/utils/flattenAttributes";
import type { Attributes } from "@opentelemetry/api";
import type { CreateEventInput } from "./app/v3/eventRepository/eventRepository.types";

const ORG_TITLE = "AI Spans Dev";
const PROJECT_NAME = "ai-chat-demo";
const TASK_SLUG = "ai-chat";
const QUEUE_NAME = "task/ai-chat";
const WORKER_VERSION = "seed-ai-spans-v1";

// ---------------------------------------------------------------------------
// ClickHouse formatting helpers (replicated from clickhouseEventRepository)
// ---------------------------------------------------------------------------

function formatStartTime(startTimeNs: bigint): string {
  const str = startTimeNs.toString();
  if (str.length !== 19) return str;
  return str.substring(0, 10) + "." + str.substring(10);
}

function formatDuration(value: number | bigint): string {
  if (value < 0) return "0";
  if (typeof value === "bigint") return value.toString();
  return Math.floor(value).toString();
}

function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function removePrivateProperties(attributes: Attributes): Attributes | undefined {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("$") || key.startsWith("ctx.")) continue;
    result[key] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function eventToClickhouseRow(event: CreateEventInput): TaskEventV2Input {
  // kind
  let kind: string;
  if (event.kind === "UNSPECIFIED") kind = "ANCESTOR_OVERRIDE";
  else if (event.level === "TRACE") kind = "SPAN";
  else if (event.isDebug) kind = "DEBUG_EVENT";
  else kind = `LOG_${(event.level ?? "LOG").toString().toUpperCase()}`;

  // status
  let status: string;
  if (event.isPartial) status = "PARTIAL";
  else if (event.isError) status = "ERROR";
  else if (event.isCancelled) status = "CANCELLED";
  else status = "OK";

  // attributes
  const publicAttrs = removePrivateProperties(event.properties as Attributes);
  const unflattened = publicAttrs ? unflattenAttributes(publicAttrs) : {};
  const attributes =
    unflattened && typeof unflattened === "object" ? { ...unflattened } : {};

  // metadata — mirrors createEventToTaskEventV1InputMetadata
  const metadataObj: Record<string, unknown> = {};
  if (event.style) {
    metadataObj.style = unflattenAttributes(event.style as Attributes);
  }
  if (event.attemptNumber) {
    metadataObj.attemptNumber = event.attemptNumber;
  }
  // Extract entity from properties (SemanticInternalAttributes)
  const entityType = event.properties?.["$entity.type"];
  if (typeof entityType === "string") {
    metadataObj.entity = {
      entityType,
      entityId: event.properties?.["$entity.id"] as string | undefined,
      entityMetadata: event.properties?.["$entity.metadata"] as string | undefined,
    };
  }
  const metadata = JSON.stringify(metadataObj);

  return {
    environment_id: event.environmentId,
    organization_id: event.organizationId,
    project_id: event.projectId,
    task_identifier: event.taskSlug,
    run_id: event.runId,
    start_time: formatStartTime(BigInt(event.startTime)),
    duration: formatDuration(event.duration ?? 0),
    trace_id: event.traceId,
    span_id: event.spanId,
    parent_span_id: event.parentId ?? "",
    message: event.message,
    kind,
    status,
    attributes,
    metadata,
    expires_at: formatClickhouseDateTime(
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    ),
    machine_id: "",
  };
}

function eventToLlmUsageRow(event: CreateEventInput): LlmUsageV1Input {
  const llm = event._llmUsage!;
  return {
    organization_id: event.organizationId,
    project_id: event.projectId,
    environment_id: event.environmentId,
    run_id: event.runId,
    task_identifier: event.taskSlug,
    trace_id: event.traceId,
    span_id: event.spanId,
    gen_ai_system: llm.genAiSystem,
    request_model: llm.requestModel,
    response_model: llm.responseModel,
    matched_model_id: llm.matchedModelId,
    operation_name: llm.operationName,
    pricing_tier_id: llm.pricingTierId,
    pricing_tier_name: llm.pricingTierName,
    input_tokens: llm.inputTokens,
    output_tokens: llm.outputTokens,
    total_tokens: llm.totalTokens,
    usage_details: llm.usageDetails,
    input_cost: llm.inputCost,
    output_cost: llm.outputCost,
    total_cost: llm.totalCost,
    cost_details: llm.costDetails,
    metadata: llm.metadata,
    start_time: formatStartTime(BigInt(event.startTime)),
    duration: formatDuration(event.duration ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function seedAiSpans() {
  crumb("seed started"); // @crumbs
  console.log("Starting AI span seed...\n");

  // 1. Find user
  crumb("finding user"); // @crumbs
  const user = await prisma.user.findUnique({
    where: { email: "local@trigger.dev" },
  });
  if (!user) {
    console.error("User local@trigger.dev not found. Run `pnpm run db:seed` first.");
    process.exit(1);
  }
  crumb("user found", { userId: user.id }); // @crumbs

  // 2. Find or create org
  crumb("finding/creating org"); // @crumbs
  let org = await prisma.organization.findFirst({
    where: { title: ORG_TITLE, members: { some: { userId: user.id } } },
  });
  if (!org) {
    org = await createOrganization({ title: ORG_TITLE, userId: user.id, companySize: "1-10" });
    console.log(`Created org: ${org.title} (${org.slug})`);
  } else {
    console.log(`Org exists: ${org.title} (${org.slug})`);
  }
  crumb("org ready", { orgId: org.id, slug: org.slug }); // @crumbs

  // 3. Find or create project
  crumb("finding/creating project"); // @crumbs
  let project = await prisma.project.findFirst({
    where: { name: PROJECT_NAME, organizationId: org.id },
  });
  if (!project) {
    project = await createProject({
      organizationSlug: org.slug,
      name: PROJECT_NAME,
      userId: user.id,
      version: "v3",
    });
    console.log(`Created project: ${project.name} (${project.externalRef})`);
  } else {
    console.log(`Project exists: ${project.name} (${project.externalRef})`);
  }
  crumb("project ready", { projectId: project.id, ref: project.externalRef }); // @crumbs

  // 4. Get DEVELOPMENT environment
  crumb("finding dev environment"); // @crumbs
  const runtimeEnv = await prisma.runtimeEnvironment.findFirst({
    where: { projectId: project.id, type: "DEVELOPMENT" },
  });
  if (!runtimeEnv) {
    console.error("No DEVELOPMENT environment found for project.");
    process.exit(1);
  }
  crumb("dev env found", { envId: runtimeEnv.id }); // @crumbs

  // 5. Upsert background worker
  crumb("upserting worker/task/queue"); // @crumbs
  const worker = await prisma.backgroundWorker.upsert({
    where: {
      projectId_runtimeEnvironmentId_version: {
        projectId: project.id,
        runtimeEnvironmentId: runtimeEnv.id,
        version: WORKER_VERSION,
      },
    },
    update: {},
    create: {
      friendlyId: `worker_${nanoid()}`,
      engine: "V2",
      contentHash: `seed-ai-spans-${Date.now()}`,
      sdkVersion: "3.0.0",
      cliVersion: "3.0.0",
      projectId: project.id,
      runtimeEnvironmentId: runtimeEnv.id,
      version: WORKER_VERSION,
      metadata: {},
    },
  });

  // 6. Upsert task
  await prisma.backgroundWorkerTask.upsert({
    where: { workerId_slug: { workerId: worker.id, slug: TASK_SLUG } },
    update: {},
    create: {
      friendlyId: `task_${nanoid()}`,
      slug: TASK_SLUG,
      filePath: "src/trigger/ai-chat.ts",
      exportName: "aiChat",
      workerId: worker.id,
      projectId: project.id,
      runtimeEnvironmentId: runtimeEnv.id,
    },
  });

  // 7. Upsert queue
  await prisma.taskQueue.upsert({
    where: {
      runtimeEnvironmentId_name: {
        runtimeEnvironmentId: runtimeEnv.id,
        name: QUEUE_NAME,
      },
    },
    update: {},
    create: {
      friendlyId: `queue_${nanoid()}`,
      name: QUEUE_NAME,
      projectId: project.id,
      runtimeEnvironmentId: runtimeEnv.id,
    },
  });

  crumb("infra upserts done"); // @crumbs

  // 8. Create the TaskRun
  crumb("creating TaskRun"); // @crumbs
  const traceId = generateTraceId();
  const rootSpanId = generateSpanId();
  const now = Date.now();
  // Spans start at `now` and extend into the future. completedAt must cover
  // the full span tree so getSpan's start_time <= completedAt filter works.
  const startedAt = new Date(now);
  const completedAt = new Date(now + 150_000); // 2.5 min to cover all spans

  const run = await prisma.taskRun.create({
    data: {
      friendlyId: `run_${nanoid()}`,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      taskIdentifier: TASK_SLUG,
      payload: JSON.stringify({
        message: "What is the current Federal Reserve interest rate?",
      }),
      payloadType: "application/json",
      traceId,
      spanId: rootSpanId,
      runtimeEnvironmentId: runtimeEnv.id,
      projectId: project.id,
      organizationId: org.id,
      queue: QUEUE_NAME,
      lockedToVersionId: worker.id,
      startedAt,
      completedAt,
      runTags: ["user:seed_user_42", "chat:seed_session"],
      taskEventStore: "clickhouse_v2",
    },
  });

  crumb("TaskRun created", { runId: run.friendlyId, traceId }); // @crumbs
  console.log(`Created TaskRun: ${run.friendlyId}`);

  // 9. Build span tree
  crumb("building span tree"); // @crumbs
  const events = buildAiSpanTree({
    traceId,
    rootSpanId,
    runId: run.friendlyId,
    environmentId: runtimeEnv.id,
    projectId: project.id,
    organizationId: org.id,
    taskSlug: TASK_SLUG,
    baseTimeMs: now,
  });

  crumb("span tree built", { spanCount: events.length }); // @crumbs
  console.log(`Built ${events.length} spans`);

  // 10. Seed LLM pricing and enrich
  crumb("seeding LLM pricing"); // @crumbs
  const seedResult = await seedLlmPricing(prisma);
  console.log(
    `LLM pricing: ${seedResult.modelsCreated} created, ${seedResult.modelsSkipped} skipped`
  );

  crumb("loading pricing registry"); // @crumbs
  const registry = new ModelPricingRegistry(prisma);
  setLlmPricingRegistry(registry);
  await registry.loadFromDatabase();

  crumb("enriching events"); // @crumbs
  const enriched = enrichCreatableEvents(events);

  const enrichedCount = enriched.filter((e) => e._llmUsage != null).length;
  const totalCost = enriched.reduce((sum, e) => sum + (e._llmUsage?.totalCost ?? 0), 0);
  console.log(
    `Enriched ${enrichedCount} spans with LLM cost (total: $${totalCost.toFixed(6)})`
  );

  crumb("enrichment done", { enrichedCount, totalCost }); // @crumbs

  // 11. Insert into ClickHouse
  crumb("inserting into ClickHouse"); // @crumbs
  const clickhouseUrl = process.env.CLICKHOUSE_URL ?? process.env.EVENTS_CLICKHOUSE_URL;
  if (!clickhouseUrl) {
    console.error("CLICKHOUSE_URL or EVENTS_CLICKHOUSE_URL not set");
    process.exit(1);
  }

  const url = new URL(clickhouseUrl);
  url.searchParams.delete("secure");
  const clickhouse = new ClickHouse({ url: url.toString() });

  // Convert to ClickHouse rows and insert
  const chRows = enriched.map(eventToClickhouseRow);
  await clickhouse.taskEventsV2.insert(chRows);

  crumb("task events inserted", { rowCount: chRows.length }); // @crumbs

  // Insert LLM usage rows
  const llmRows = enriched.filter((e) => e._llmUsage != null).map(eventToLlmUsageRow);
  if (llmRows.length > 0) {
    await clickhouse.llmUsage.insert(llmRows);
    crumb("llm usage inserted", { rowCount: llmRows.length }); // @crumbs
  }

  // 12. Output
  console.log("\nDone!\n");
  console.log(
    `Run URL: http://localhost:3030/orgs/${org.slug}/projects/${project.slug}/env/dev/runs/${run.friendlyId}`
  );
  console.log(`Spans: ${events.length}`);
  console.log(`LLM cost enriched: ${enrichedCount}`);
  console.log(`Total cost: $${totalCost.toFixed(6)}`);
  crumb("seed complete"); // @crumbs
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Span tree builder
// ---------------------------------------------------------------------------

type SpanTreeParams = {
  traceId: string;
  rootSpanId: string;
  runId: string;
  environmentId: string;
  projectId: string;
  organizationId: string;
  taskSlug: string;
  baseTimeMs: number;
};

function buildAiSpanTree(params: SpanTreeParams): CreateEventInput[] {
  const {
    traceId,
    rootSpanId,
    runId,
    environmentId,
    projectId,
    organizationId,
    taskSlug,
    baseTimeMs,
  } = params;

  const events: CreateEventInput[] = [];
  const runTags = ["user:seed_user_42", "chat:seed_session"];

  // Timing cursor — each span advances this
  let cursor = baseTimeMs;
  function next(durationMs: number) {
    const start = cursor;
    cursor += durationMs + 50; // 50ms gap between spans
    return { startMs: start, durationMs };
  }

  function makeEvent(opts: {
    message: string;
    spanId: string;
    parentId: string | undefined;
    startMs: number;
    durationMs: number;
    properties: Record<string, unknown>;
    style?: Record<string, unknown>;
    attemptNumber?: number;
  }): CreateEventInput {
    const startNs = BigInt(opts.startMs) * BigInt(1_000_000);
    const durationNs = opts.durationMs * 1_000_000;
    return {
      traceId,
      spanId: opts.spanId,
      parentId: opts.parentId,
      message: opts.message,
      kind: "INTERNAL" as any,
      status: "OK" as any,
      level: "TRACE" as any,
      startTime: startNs,
      duration: durationNs,
      isError: false,
      isPartial: false,
      isCancelled: false,
      isDebug: false,
      runId,
      environmentId,
      projectId,
      organizationId,
      taskSlug,
      properties: opts.properties,
      metadata: undefined,
      style: opts.style as any,
      events: undefined,
      runTags,
      attemptNumber: opts.attemptNumber,
    };
  }

  // --- Shared prompt content ---
  const userMessage = "What is the current Federal Reserve interest rate?";
  const systemPrompt = "You are a helpful financial assistant with access to web search tools.";
  const assistantResponse =
    "The current Federal Reserve interest rate target range is 4.25% to 4.50%. This was set by the FOMC at their most recent meeting.";
  const toolCallResult = JSON.stringify({
    status: 200,
    contentType: "text/html",
    body: "<html>...Federal Reserve maintains the target range for the federal funds rate at 4-1/4 to 4-1/2 percent...</html>",
    truncated: true,
  });
  const promptMessages = JSON.stringify([
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ]);
  const toolDefs = JSON.stringify([
    JSON.stringify({
      type: "function",
      name: "webSearch",
      description: "Search the web for information",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          num: { type: "number" },
        },
        required: ["query"],
      },
    }),
  ]);
  const toolCallsJson = JSON.stringify([
    {
      id: "call_seed_001",
      type: "function",
      function: {
        name: "webSearch",
        arguments: '{"query":"federal reserve interest rate 2024","num":5}',
      },
    },
  ]);

  // --- Span IDs ---
  const attemptId = generateSpanId();
  const runFnId = generateSpanId();

  // streamText sub-tree IDs
  const streamWrapId = generateSpanId();
  const stream1Id = generateSpanId();
  const toolCall1Id = generateSpanId();
  const stream2Id = generateSpanId();

  // generateText sub-tree IDs (Anthropic with cache)
  const genTextWrapId = generateSpanId();
  const genTextDoId = generateSpanId();
  const toolCall2Id = generateSpanId();

  // generateObject sub-tree IDs (gateway → xAI)
  const genObjWrapId = generateSpanId();
  const genObjDoId = generateSpanId();

  // generateObject sub-tree IDs (Google Gemini)
  const genObjGeminiWrapId = generateSpanId();
  const genObjGeminiDoId = generateSpanId();

  // =====================================================================
  // Structural spans: root → attempt → run()
  // =====================================================================
  const rootStart = baseTimeMs;
  const totalDuration = 120_000; // 2 minutes to cover all ~18 scenarios

  events.push(
    makeEvent({
      message: taskSlug,
      spanId: rootSpanId,
      parentId: undefined,
      startMs: rootStart,
      durationMs: totalDuration,
      properties: {},
    })
  );

  events.push(
    makeEvent({
      message: "Attempt 1",
      spanId: attemptId,
      parentId: rootSpanId,
      startMs: rootStart + 30,
      durationMs: totalDuration - 60,
      properties: { "$entity.type": "attempt" },
      style: { icon: "attempt", variant: "cold" },
      attemptNumber: 1,
    })
  );

  events.push(
    makeEvent({
      message: "run()",
      spanId: runFnId,
      parentId: attemptId,
      startMs: rootStart + 60,
      durationMs: totalDuration - 120,
      properties: {},
      style: { icon: "task-fn-run" },
      attemptNumber: 1,
    })
  );

  // =====================================================================
  // 1) ai.streamText — OpenAI gpt-4o-mini with tool use (2 LLM calls)
  // =====================================================================
  cursor = rootStart + 100;
  const stWrap = next(9_500);

  events.push(
    makeEvent({
      message: "ai.streamText",
      spanId: streamWrapId,
      parentId: runFnId,
      ...stWrap,
      properties: {
        "ai.operationId": "ai.streamText",
        "ai.model.id": "gpt-4o-mini",
        "ai.model.provider": "openai.responses",
        "ai.response.finishReason": "stop",
        "ai.response.text": assistantResponse,
        "ai.usage.inputTokens": 807,
        "ai.usage.outputTokens": 242,
        "ai.usage.totalTokens": 1049,
        "ai.telemetry.metadata.userId": "seed_user_42",
        "ai.telemetry.functionId": "ai-chat",
        "operation.name": "ai.streamText",
      },
    })
  );

  cursor = stWrap.startMs + 50;
  const st1 = next(2_500);
  events.push(
    makeEvent({
      message: "ai.streamText.doStream",
      spanId: stream1Id,
      parentId: streamWrapId,
      ...st1,
      properties: {
        "gen_ai.system": "openai.responses",
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.response.model": "gpt-4o-mini-2024-07-18",
        "gen_ai.usage.input_tokens": 284,
        "gen_ai.usage.output_tokens": 55,
        "ai.model.id": "gpt-4o-mini",
        "ai.model.provider": "openai.responses",
        "ai.operationId": "ai.streamText.doStream",
        "ai.prompt.messages": promptMessages,
        "ai.prompt.tools": toolDefs,
        "ai.prompt.toolChoice": '{"type":"auto"}',
        "ai.settings.maxRetries": 2,
        "ai.response.finishReason": "tool-calls",
        "ai.response.toolCalls": toolCallsJson,
        "ai.response.text": "",
        "ai.response.id": "resp_seed_001",
        "ai.response.model": "gpt-4o-mini-2024-07-18",
        "ai.response.msToFirstChunk": 891.37,
        "ai.response.msToFinish": 2321.12,
        "ai.response.timestamp": new Date(st1.startMs + st1.durationMs).toISOString(),
        "ai.usage.inputTokens": 284,
        "ai.usage.outputTokens": 55,
        "ai.usage.totalTokens": 339,
        "ai.telemetry.metadata.userId": "seed_user_42",
        "ai.telemetry.functionId": "ai-chat",
        "operation.name": "ai.streamText.doStream",
      },
    })
  );

  const tc1 = next(3_000);
  events.push(
    makeEvent({
      message: "ai.toolCall",
      spanId: toolCall1Id,
      parentId: streamWrapId,
      ...tc1,
      properties: {
        "ai.operationId": "ai.toolCall",
        "ai.toolCall.name": "webSearch",
        "ai.toolCall.id": "call_seed_001",
        "ai.toolCall.args": '{"query":"federal reserve interest rate 2024","num":5}',
        "ai.toolCall.result": toolCallResult,
        "operation.name": "ai.toolCall",
      },
    })
  );

  const st2 = next(3_500);
  events.push(
    makeEvent({
      message: "ai.streamText.doStream",
      spanId: stream2Id,
      parentId: streamWrapId,
      ...st2,
      properties: {
        "gen_ai.system": "openai.responses",
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.response.model": "gpt-4o-mini-2024-07-18",
        "gen_ai.usage.input_tokens": 523,
        "gen_ai.usage.output_tokens": 187,
        "ai.model.id": "gpt-4o-mini",
        "ai.model.provider": "openai.responses",
        "ai.operationId": "ai.streamText.doStream",
        "ai.prompt.messages": promptMessages,
        "ai.settings.maxRetries": 2,
        "ai.response.finishReason": "stop",
        "ai.response.text": assistantResponse,
        "ai.response.reasoning":
          "Let me analyze the Federal Reserve data to provide the current rate.",
        "ai.response.id": "resp_seed_002",
        "ai.response.model": "gpt-4o-mini-2024-07-18",
        "ai.response.msToFirstChunk": 672.45,
        "ai.response.msToFinish": 3412.89,
        "ai.response.timestamp": new Date(st2.startMs + st2.durationMs).toISOString(),
        "ai.usage.inputTokens": 523,
        "ai.usage.outputTokens": 187,
        "ai.usage.totalTokens": 710,
        "ai.usage.reasoningTokens": 42,
        "ai.telemetry.metadata.userId": "seed_user_42",
        "ai.telemetry.functionId": "ai-chat",
        "operation.name": "ai.streamText.doStream",
      },
    })
  );

  // =====================================================================
  // 2) ai.generateText — Anthropic claude-haiku-4-5 with tool call + cache
  // =====================================================================
  const gtWrap = next(4_200);

  events.push(
    makeEvent({
      message: "ai.generateText",
      spanId: genTextWrapId,
      parentId: runFnId,
      ...gtWrap,
      properties: {
        "ai.operationId": "ai.generateText",
        "ai.model.id": "claude-haiku-4-5",
        "ai.model.provider": "anthropic.messages",
        "ai.response.finishReason": "stop",
        "ai.response.text": "Based on the search results, the current rate is 4.25%-4.50%.",
        "ai.usage.promptTokens": 9951,
        "ai.usage.completionTokens": 803,
        "ai.telemetry.metadata.agentName": "research-agent",
        "ai.telemetry.functionId": "ai-chat",
        "operation.name": "ai.generateText",
      },
    })
  );

  cursor = gtWrap.startMs + 50;
  const gtDo = next(3_200);
  events.push(
    makeEvent({
      message: "ai.generateText.doGenerate",
      spanId: genTextDoId,
      parentId: genTextWrapId,
      ...gtDo,
      properties: {
        "gen_ai.system": "anthropic.messages",
        "gen_ai.request.model": "claude-haiku-4-5",
        "gen_ai.response.model": "claude-haiku-4-5-20251001",
        "gen_ai.usage.input_tokens": 9951,
        "gen_ai.usage.output_tokens": 803,
        "gen_ai.usage.cache_read_input_tokens": 8200,
        "gen_ai.usage.cache_creation_input_tokens": 1751,
        "ai.model.id": "claude-haiku-4-5",
        "ai.model.provider": "anthropic.messages",
        "ai.operationId": "ai.generateText.doGenerate",
        "ai.prompt.messages": promptMessages,
        "ai.prompt.toolChoice": '{"type":"auto"}',
        "ai.settings.maxRetries": 2,
        "ai.response.finishReason": "tool-calls",
        "ai.response.id": "msg_seed_003",
        "ai.response.model": "claude-haiku-4-5-20251001",
        "ai.response.text":
          "I'll search for the latest Federal Reserve interest rate information.",
        "ai.response.toolCalls": JSON.stringify([
          {
            toolCallId: "toolu_seed_001",
            toolName: "webSearch",
            input: '{"query":"federal reserve interest rate current"}',
          },
        ]),
        "ai.response.providerMetadata": JSON.stringify({
          anthropic: {
            usage: {
              input_tokens: 9951,
              output_tokens: 803,
              cache_creation_input_tokens: 1751,
              cache_read_input_tokens: 8200,
              service_tier: "standard",
            },
          },
        }),
        "ai.response.timestamp": new Date(gtDo.startMs + gtDo.durationMs).toISOString(),
        "ai.usage.promptTokens": 9951,
        "ai.usage.completionTokens": 803,
        "ai.telemetry.metadata.agentName": "research-agent",
        "ai.telemetry.functionId": "ai-chat",
        "operation.name": "ai.generateText.doGenerate",
      },
    })
  );

  const tc2 = next(500);
  events.push(
    makeEvent({
      message: "ai.toolCall",
      spanId: toolCall2Id,
      parentId: genTextWrapId,
      ...tc2,
      properties: {
        "ai.operationId": "ai.toolCall",
        "ai.toolCall.name": "webSearch",
        "ai.toolCall.id": "toolu_seed_001",
        "ai.toolCall.args": '{"query":"federal reserve interest rate current"}',
        "ai.toolCall.result":
          '[{"title":"Federal Reserve Board - Policy Rate","link":"https://federalreserve.gov/rates","snippet":"The target range is 4.25% to 4.50%"}]',
        "operation.name": "ai.toolCall",
        "resource.name": "ai-chat",
      },
    })
  );

  // =====================================================================
  // 3) ai.generateObject — Gateway → xAI/grok with structured output
  // =====================================================================
  const goWrap = next(1_800);

  events.push(
    makeEvent({
      message: "ai.generateObject",
      spanId: genObjWrapId,
      parentId: runFnId,
      ...goWrap,
      properties: {
        "ai.operationId": "ai.generateObject",
        "ai.model.id": "xai/grok-4.1-fast-non-reasoning",
        "ai.model.provider": "gateway",
        "ai.response.finishReason": "stop",
        "ai.response.object": JSON.stringify({
          summary: "Fed rate at 4.25%-4.50%",
          confidence: 0.95,
          sources: ["federalreserve.gov"],
        }),
        "ai.telemetry.metadata.model": "xai/grok-4.1-fast-non-reasoning",
        "ai.telemetry.metadata.schemaType": "schema",
        "ai.telemetry.functionId": "generateObject",
        "operation.name": "ai.generateObject",
      },
    })
  );

  cursor = goWrap.startMs + 50;
  const goDo = next(1_600);
  events.push(
    makeEvent({
      message: "ai.generateObject.doGenerate",
      spanId: genObjDoId,
      parentId: genObjWrapId,
      ...goDo,
      properties: {
        "gen_ai.system": "gateway",
        "gen_ai.request.model": "xai/grok-4.1-fast-non-reasoning",
        "gen_ai.response.model": "xai/grok-4.1-fast-non-reasoning",
        "gen_ai.usage.input_tokens": 1629,
        "gen_ai.usage.output_tokens": 158,
        "ai.model.id": "xai/grok-4.1-fast-non-reasoning",
        "ai.model.provider": "gateway",
        "ai.operationId": "ai.generateObject.doGenerate",
        "ai.prompt.messages": promptMessages,
        "ai.settings.maxRetries": 3,
        "ai.response.finishReason": "stop",
        "ai.response.id": "aiobj_seed_001",
        "ai.response.model": "xai/grok-4.1-fast-non-reasoning",
        "ai.response.object": JSON.stringify({
          summary: "Fed rate at 4.25%-4.50%",
          confidence: 0.95,
          sources: ["federalreserve.gov"],
        }),
        "ai.response.providerMetadata": JSON.stringify({
          gateway: {
            routing: {
              originalModelId: "xai/grok-4.1-fast-non-reasoning",
              resolvedProvider: "xai",
              canonicalSlug: "xai/grok-4.1-fast-non-reasoning",
              finalProvider: "xai",
              modelAttemptCount: 1,
            },
            cost: "0.0002905",
            generationId: "gen_seed_001",
          },
        }),
        "ai.response.timestamp": new Date(goDo.startMs + goDo.durationMs).toISOString(),
        "ai.usage.completionTokens": 158,
        "ai.usage.promptTokens": 1629,
        "ai.request.headers.user-agent": "ai/5.0.60",
        "operation.name": "ai.generateObject.doGenerate",
      },
    })
  );

  // =====================================================================
  // 4) ai.generateObject — Google Gemini (generative-ai) with thinking tokens
  // =====================================================================
  const goGemWrap = next(2_200);

  events.push(
    makeEvent({
      message: "ai.generateObject",
      spanId: genObjGeminiWrapId,
      parentId: runFnId,
      ...goGemWrap,
      properties: {
        "ai.operationId": "ai.generateObject",
        "ai.model.id": "gemini-2.5-flash",
        "ai.model.provider": "google.generative-ai",
        "ai.response.finishReason": "stop",
        "ai.response.object": JSON.stringify({
          category: "financial_data",
          label: "interest_rate",
        }),
        "ai.telemetry.functionId": "classify-content",
        "operation.name": "ai.generateObject",
      },
    })
  );

  cursor = goGemWrap.startMs + 50;
  const goGemDo = next(2_000);
  events.push(
    makeEvent({
      message: "ai.generateObject.doGenerate",
      spanId: genObjGeminiDoId,
      parentId: genObjGeminiWrapId,
      ...goGemDo,
      properties: {
        "gen_ai.system": "google.generative-ai",
        "gen_ai.request.model": "gemini-2.5-flash",
        "gen_ai.response.model": "gemini-2.5-flash",
        "gen_ai.usage.input_tokens": 898,
        "gen_ai.usage.output_tokens": 521,
        "ai.model.id": "gemini-2.5-flash",
        "ai.model.provider": "google.generative-ai",
        "ai.operationId": "ai.generateObject.doGenerate",
        "ai.prompt.messages": JSON.stringify([
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Classify this content: Federal Reserve interest rate analysis",
              },
            ],
          },
        ]),
        "ai.settings.maxRetries": 3,
        "ai.response.finishReason": "stop",
        "ai.response.id": "aiobj_seed_gemini",
        "ai.response.model": "gemini-2.5-flash",
        "ai.response.object": JSON.stringify({
          category: "financial_data",
          label: "interest_rate",
        }),
        "ai.response.providerMetadata": JSON.stringify({
          google: {
            usageMetadata: {
              thoughtsTokenCount: 510,
              promptTokenCount: 898,
              candidatesTokenCount: 11,
              totalTokenCount: 1419,
            },
          },
        }),
        "ai.response.timestamp": new Date(goGemDo.startMs + goGemDo.durationMs).toISOString(),
        "ai.usage.completionTokens": 521,
        "ai.usage.promptTokens": 898,
        "operation.name": "ai.generateObject.doGenerate",
      },
    })
  );

  // =====================================================================
  // Helper: add a wrapper + doGenerate/doStream pair
  // =====================================================================
  function addLlmPair(opts: {
    wrapperMsg: string; // e.g. "ai.generateText"
    doMsg: string; // e.g. "ai.generateText.doGenerate"
    system: string;
    reqModel: string;
    respModel: string;
    inputTokens: number;
    outputTokens: number;
    finishReason: string;
    wrapperDurationMs: number;
    doDurationMs: number;
    responseText?: string;
    responseObject?: string;
    responseReasoning?: string;
    toolCallsJson?: string;
    providerMetadata?: Record<string, unknown>;
    telemetryMetadata?: Record<string, string>;
    settings?: Record<string, unknown>;
    /** Use completionTokens/promptTokens instead of inputTokens/outputTokens */
    useCompletionStyle?: boolean;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    reasoningTokens?: number;
    extraDoProps?: Record<string, unknown>;
  }) {
    const wId = generateSpanId();
    const dId = generateSpanId();

    const wrap = next(opts.wrapperDurationMs);
    const wrapperProps: Record<string, unknown> = {
      "ai.operationId": opts.wrapperMsg,
      "ai.model.id": opts.reqModel,
      "ai.model.provider": opts.system,
      "ai.response.finishReason": opts.finishReason,
      "operation.name": opts.wrapperMsg,
    };
    if (opts.responseText) wrapperProps["ai.response.text"] = opts.responseText;
    if (opts.responseObject) wrapperProps["ai.response.object"] = opts.responseObject;
    if (opts.telemetryMetadata) {
      for (const [k, v] of Object.entries(opts.telemetryMetadata)) {
        wrapperProps[`ai.telemetry.metadata.${k}`] = v;
      }
    }

    events.push(makeEvent({ message: opts.wrapperMsg, spanId: wId, parentId: runFnId, ...wrap, properties: wrapperProps }));

    cursor = wrap.startMs + 50;
    const doTiming = next(opts.doDurationMs);

    const doProps: Record<string, unknown> = {
      "gen_ai.system": opts.system,
      "gen_ai.request.model": opts.reqModel,
      "gen_ai.response.model": opts.respModel,
      "gen_ai.usage.input_tokens": opts.inputTokens,
      "gen_ai.usage.output_tokens": opts.outputTokens,
      "ai.model.id": opts.reqModel,
      "ai.model.provider": opts.system,
      "ai.operationId": opts.doMsg,
      "ai.prompt.messages": promptMessages,
      "ai.response.finishReason": opts.finishReason,
      "ai.response.id": `resp_seed_${generateSpanId().slice(0, 8)}`,
      "ai.response.model": opts.respModel,
      "ai.response.timestamp": new Date(doTiming.startMs + doTiming.durationMs).toISOString(),
      "operation.name": opts.doMsg,
    };

    // Token style
    if (opts.useCompletionStyle) {
      doProps["ai.usage.completionTokens"] = opts.outputTokens;
      doProps["ai.usage.promptTokens"] = opts.inputTokens;
    } else {
      doProps["ai.usage.inputTokens"] = opts.inputTokens;
      doProps["ai.usage.outputTokens"] = opts.outputTokens;
      doProps["ai.usage.totalTokens"] = opts.inputTokens + opts.outputTokens;
    }

    if (opts.responseText) doProps["ai.response.text"] = opts.responseText;
    if (opts.responseObject) doProps["ai.response.object"] = opts.responseObject;
    if (opts.responseReasoning) doProps["ai.response.reasoning"] = opts.responseReasoning;
    if (opts.toolCallsJson) doProps["ai.response.toolCalls"] = opts.toolCallsJson;
    if (opts.cacheReadTokens) {
      doProps["gen_ai.usage.cache_read_input_tokens"] = opts.cacheReadTokens;
    }
    if (opts.cacheCreationTokens) {
      doProps["gen_ai.usage.cache_creation_input_tokens"] = opts.cacheCreationTokens;
    }
    if (opts.reasoningTokens) {
      doProps["ai.usage.reasoningTokens"] = opts.reasoningTokens;
    }
    if (opts.providerMetadata) {
      doProps["ai.response.providerMetadata"] = JSON.stringify(opts.providerMetadata);
    }
    if (opts.settings) {
      for (const [k, v] of Object.entries(opts.settings)) {
        doProps[`ai.settings.${k}`] = v;
      }
    }
    if (opts.telemetryMetadata) {
      for (const [k, v] of Object.entries(opts.telemetryMetadata)) {
        doProps[`ai.telemetry.metadata.${k}`] = v;
      }
    }
    if (opts.extraDoProps) Object.assign(doProps, opts.extraDoProps);

    events.push(makeEvent({ message: opts.doMsg, spanId: dId, parentId: wId, ...doTiming, properties: doProps }));

    return { wrapperId: wId, doId: dId };
  }

  // Helper: add a tool call span
  function addToolCall(parentId: string, name: string, args: string, result: string, durationMs = 500) {
    const id = generateSpanId();
    const timing = next(durationMs);
    events.push(makeEvent({
      message: "ai.toolCall",
      spanId: id,
      parentId,
      ...timing,
      properties: {
        "ai.operationId": "ai.toolCall",
        "ai.toolCall.name": name,
        "ai.toolCall.id": `call_${generateSpanId().slice(0, 8)}`,
        "ai.toolCall.args": args,
        "ai.toolCall.result": result,
        "operation.name": "ai.toolCall",
      },
    }));
    return id;
  }

  // =====================================================================
  // 5) Gateway → Mistral mistral-large-3
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateText",
    doMsg: "ai.generateText.doGenerate",
    system: "gateway",
    reqModel: "mistral/mistral-large-3",
    respModel: "mistral/mistral-large-3",
    inputTokens: 1179,
    outputTokens: 48,
    finishReason: "stop",
    wrapperDurationMs: 1_400,
    doDurationMs: 1_200,
    responseText: "The document discusses quarterly earnings guidance for tech sector.",
    useCompletionStyle: true,
    providerMetadata: {
      gateway: {
        routing: {
          originalModelId: "mistral/mistral-large-3",
          resolvedProvider: "mistral",
          resolvedProviderApiModelId: "mistral-large-latest",
          canonicalSlug: "mistral/mistral-large-3",
          finalProvider: "mistral",
          modelAttemptCount: 1,
        },
        cost: "0.0006615",
        marketCost: "0.0006615",
        generationId: "gen_seed_mistral_001",
      },
    },
    extraDoProps: { "ai.request.headers.user-agent": "ai/5.0.60" },
  });

  // =====================================================================
  // 6) Gateway → OpenAI gpt-5-mini (with fallback metadata)
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateText",
    doMsg: "ai.generateText.doGenerate",
    system: "gateway",
    reqModel: "openai/gpt-5-mini",
    respModel: "openai/gpt-5-mini",
    inputTokens: 2450,
    outputTokens: 312,
    finishReason: "stop",
    wrapperDurationMs: 5_000,
    doDurationMs: 4_800,
    responseText: "NO",
    useCompletionStyle: true,
    providerMetadata: {
      openai: { responseId: "resp_seed_gw_openai", serviceTier: "default" },
      gateway: {
        routing: {
          originalModelId: "openai/gpt-5-mini",
          resolvedProvider: "openai",
          resolvedProviderApiModelId: "gpt-5-mini-2025-08-07",
          canonicalSlug: "openai/gpt-5-mini",
          finalProvider: "openai",
          fallbacksAvailable: ["azure"],
          planningReasoning: "System credentials planned for: openai, azure. Total execution order: openai(system) → azure(system)",
          modelAttemptCount: 1,
        },
        cost: "0.000482",
        generationId: "gen_seed_gpt5mini_001",
      },
    },
    extraDoProps: { "ai.request.headers.user-agent": "ai/6.0.49" },
  });

  // =====================================================================
  // 7) Gateway → DeepSeek deepseek-v3.2 (tool-calls)
  // =====================================================================
  const ds = addLlmPair({
    wrapperMsg: "ai.generateObject",
    doMsg: "ai.generateObject.doGenerate",
    system: "gateway",
    reqModel: "deepseek/deepseek-v3.2",
    respModel: "deepseek/deepseek-v3.2",
    inputTokens: 3200,
    outputTokens: 420,
    finishReason: "tool-calls",
    wrapperDurationMs: 2_800,
    doDurationMs: 2_500,
    responseObject: JSON.stringify({ action: "search", query: "fed rate history" }),
    useCompletionStyle: true,
    providerMetadata: {
      gateway: {
        routing: {
          originalModelId: "deepseek/deepseek-v3.2",
          resolvedProvider: "deepseek",
          canonicalSlug: "deepseek/deepseek-v3.2",
          finalProvider: "deepseek",
          modelAttemptCount: 1,
        },
        cost: "0.000156",
        generationId: "gen_seed_deepseek_001",
      },
    },
  });
  addToolCall(ds.wrapperId, "classifyContent", '{"text":"Federal Reserve rate analysis"}', '{"category":"finance","confidence":0.98}');

  // =====================================================================
  // 8) Gateway → Anthropic claude-haiku via gateway prefix
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateText",
    doMsg: "ai.generateText.doGenerate",
    system: "gateway",
    reqModel: "anthropic/claude-haiku-4-5-20251001",
    respModel: "anthropic/claude-haiku-4-5-20251001",
    inputTokens: 5400,
    outputTokens: 220,
    finishReason: "stop",
    wrapperDurationMs: 1_800,
    doDurationMs: 1_500,
    responseText: "The content appears to be a standard financial news article. Classification: SAFE.",
    useCompletionStyle: true,
    providerMetadata: {
      gateway: {
        routing: {
          originalModelId: "anthropic/claude-haiku-4-5-20251001",
          resolvedProvider: "anthropic",
          canonicalSlug: "anthropic/claude-haiku-4-5-20251001",
          finalProvider: "anthropic",
          modelAttemptCount: 1,
        },
        cost: "0.00312",
        generationId: "gen_seed_gw_anthropic_001",
      },
    },
  });

  // =====================================================================
  // 9) Gateway → Google gemini-3-flash-preview (structured output)
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateObject",
    doMsg: "ai.generateObject.doGenerate",
    system: "gateway",
    reqModel: "google/gemini-3-flash-preview",
    respModel: "google/gemini-3-flash-preview",
    inputTokens: 720,
    outputTokens: 85,
    finishReason: "stop",
    wrapperDurationMs: 1_200,
    doDurationMs: 1_000,
    responseObject: JSON.stringify({ sentiment: "neutral", topics: ["monetary_policy", "interest_rates"] }),
    useCompletionStyle: true,
    providerMetadata: {
      gateway: {
        routing: {
          originalModelId: "google/gemini-3-flash-preview",
          resolvedProvider: "google",
          canonicalSlug: "google/gemini-3-flash-preview",
          finalProvider: "google",
          modelAttemptCount: 1,
        },
        cost: "0.0000803",
        generationId: "gen_seed_gw_gemini_001",
      },
    },
  });

  // =====================================================================
  // 10) OpenRouter → x-ai/grok-4-fast (with reasoning_details)
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateObject",
    doMsg: "ai.generateObject.doGenerate",
    system: "openrouter",
    reqModel: "x-ai/grok-4-fast",
    respModel: "x-ai/grok-4-fast",
    inputTokens: 375,
    outputTokens: 226,
    finishReason: "stop",
    wrapperDurationMs: 1_600,
    doDurationMs: 1_400,
    responseObject: JSON.stringify({ hook: "Breaking: Fed holds rates steady", isValidHook: true }),
    useCompletionStyle: true,
    telemetryMetadata: { model: "x-ai/grok-4-fast", schemaType: "schema", temperature: "1" },
    settings: { maxRetries: 2, temperature: 1 },
    providerMetadata: {
      openrouter: {
        provider: "xAI",
        reasoning_details: [{ type: "reasoning.encrypted", data: "encrypted_seed_data..." }],
        usage: {
          promptTokens: 375,
          promptTokensDetails: { cachedTokens: 343 },
          completionTokens: 226,
          completionTokensDetails: { reasoningTokens: 210 },
          totalTokens: 601,
          cost: 0.0001351845,
          costDetails: { upstreamInferenceCost: 0.00013655 },
        },
      },
    },
  });

  // =====================================================================
  // 11) OpenRouter → google/gemini-2.5-flash
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateText",
    doMsg: "ai.generateText.doGenerate",
    system: "openrouter",
    reqModel: "google/gemini-2.5-flash",
    respModel: "google/gemini-2.5-flash",
    inputTokens: 1840,
    outputTokens: 320,
    finishReason: "stop",
    wrapperDurationMs: 2_000,
    doDurationMs: 1_800,
    responseText: "Based on the latest FOMC minutes, the committee voted unanimously to maintain rates.",
    useCompletionStyle: true,
    providerMetadata: {
      openrouter: {
        provider: "Google AI Studio",
        usage: {
          promptTokens: 1840,
          completionTokens: 320,
          totalTokens: 2160,
          cost: 0.000264,
          costDetails: { upstreamInferenceCost: 0.000232 },
        },
      },
    },
  });

  // =====================================================================
  // 12) OpenRouter → openai/gpt-4.1-mini (req ≠ resp model name)
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateObject",
    doMsg: "ai.generateObject.doGenerate",
    system: "openrouter",
    reqModel: "openai/gpt-4.1-mini",
    respModel: "openai/gpt-4.1-mini-2025-04-14",
    inputTokens: 890,
    outputTokens: 145,
    finishReason: "stop",
    wrapperDurationMs: 1_400,
    doDurationMs: 1_200,
    responseObject: JSON.stringify({ summary: "Rate unchanged at 4.25-4.50%", date: "2024-12-18" }),
    useCompletionStyle: true,
    providerMetadata: {
      openrouter: {
        provider: "OpenAI",
        usage: {
          promptTokens: 890,
          completionTokens: 145,
          totalTokens: 1035,
          cost: 0.0000518,
        },
      },
    },
  });

  // =====================================================================
  // 13) Azure → gpt-5 with tool-calls
  // =====================================================================
  const az = addLlmPair({
    wrapperMsg: "ai.generateText",
    doMsg: "ai.generateText.doGenerate",
    system: "azure.responses",
    reqModel: "gpt-5-2025-08-07",
    respModel: "gpt-5-2025-08-07",
    inputTokens: 2038,
    outputTokens: 239,
    finishReason: "tool-calls",
    wrapperDurationMs: 3_500,
    doDurationMs: 3_000,
    responseText: "Let me look up the latest rate decision.",
    toolCallsJson: JSON.stringify([{
      toolCallId: "call_azure_001",
      toolName: "lookupRate",
      input: '{"source":"federal_reserve","metric":"funds_rate"}',
    }]),
    providerMetadata: {
      azure: { responseId: "resp_seed_azure_001", serviceTier: "default" },
    },
  });
  addToolCall(az.wrapperId, "lookupRate", '{"source":"federal_reserve","metric":"funds_rate"}', '{"rate":"4.25-4.50%","effectiveDate":"2024-12-18"}');

  // =====================================================================
  // 14) Perplexity → sonar-pro
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateText",
    doMsg: "ai.generateText.doGenerate",
    system: "perplexity",
    reqModel: "sonar-pro",
    respModel: "sonar-pro",
    inputTokens: 151,
    outputTokens: 428,
    finishReason: "stop",
    wrapperDurationMs: 4_500,
    doDurationMs: 4_200,
    responseText: "According to the Federal Reserve's most recent announcement on December 18, 2024, the federal funds rate target range was maintained at 4.25% to 4.50%. This decision was made during the December FOMC meeting.",
  });

  // =====================================================================
  // 15) openai.chat → gpt-4o-mini (legacy chat completions, mode: "tool")
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateObject",
    doMsg: "ai.generateObject.doGenerate",
    system: "openai.chat",
    reqModel: "gpt-4o-mini",
    respModel: "gpt-4o-mini-2024-07-18",
    inputTokens: 573,
    outputTokens: 11,
    finishReason: "stop",
    wrapperDurationMs: 800,
    doDurationMs: 600,
    responseObject: JSON.stringify({ title: "Fed Rate Hold", emoji: "🏦" }),
    settings: { maxRetries: 2, mode: "tool", temperature: 0.3 },
    providerMetadata: {
      openai: { reasoningTokens: 0, cachedPromptTokens: 0 },
    },
  });

  // =====================================================================
  // 16) Anthropic claude-sonnet-4-5 → streamText with reasoning
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.streamText",
    doMsg: "ai.streamText.doStream",
    system: "anthropic.messages",
    reqModel: "claude-sonnet-4-5-20250929",
    respModel: "claude-sonnet-4-5-20250929",
    inputTokens: 15200,
    outputTokens: 2840,
    finishReason: "stop",
    wrapperDurationMs: 12_000,
    doDurationMs: 11_500,
    responseText: "The Federal Reserve has maintained its target range for the federal funds rate at 4.25% to 4.50% since December 2024. This represents a pause in the rate-cutting cycle that began in September 2024. The FOMC has indicated it will continue to assess incoming data, the evolving outlook, and the balance of risks when considering further adjustments.",
    responseReasoning: "The user is asking about the current Federal Reserve interest rate. Let me provide a comprehensive answer based on the most recent FOMC decision. I should include context about the rate trajectory and forward guidance.",
    cacheReadTokens: 12400,
    cacheCreationTokens: 2800,
    providerMetadata: {
      anthropic: {
        usage: {
          input_tokens: 15200,
          output_tokens: 2840,
          cache_creation_input_tokens: 2800,
          cache_read_input_tokens: 12400,
          service_tier: "standard",
          inference_geo: "us-east-1",
        },
      },
    },
  });

  // =====================================================================
  // 17) google.vertex.chat → gemini-3.1-pro-preview with tool-calls
  // =====================================================================
  const vt = addLlmPair({
    wrapperMsg: "ai.generateText",
    doMsg: "ai.generateText.doGenerate",
    system: "google.vertex.chat",
    reqModel: "gemini-3.1-pro-preview",
    respModel: "gemini-3.1-pro-preview",
    inputTokens: 4200,
    outputTokens: 680,
    finishReason: "tool-calls",
    wrapperDurationMs: 6_000,
    doDurationMs: 5_500,
    responseText: "I'll search for the latest FOMC decision and rate information.",
    toolCallsJson: JSON.stringify([{
      toolCallId: "call_vertex_001",
      toolName: "searchFOMC",
      input: '{"query":"latest FOMC decision december 2024"}',
    }]),
    providerMetadata: {
      google: {
        usageMetadata: {
          thoughtsTokenCount: 320,
          promptTokenCount: 4200,
          candidatesTokenCount: 680,
          totalTokenCount: 5200,
        },
      },
    },
  });
  addToolCall(vt.wrapperId, "searchFOMC", '{"query":"latest FOMC decision december 2024"}', '{"decision":"hold","rate":"4.25-4.50%","date":"2024-12-18","vote":"unanimous"}', 800);

  // =====================================================================
  // 18) openai.responses → gpt-5.4 with reasoning tokens
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.streamText",
    doMsg: "ai.streamText.doStream",
    system: "openai.responses",
    reqModel: "gpt-5.4",
    respModel: "gpt-5.4-2026-03-05",
    inputTokens: 8900,
    outputTokens: 1250,
    finishReason: "stop",
    wrapperDurationMs: 8_000,
    doDurationMs: 7_500,
    responseText: "The Federal Reserve's current target range for the federal funds rate is 4.25% to 4.50%, established at the December 2024 FOMC meeting. The committee has signaled a cautious approach to further rate cuts, citing persistent inflation concerns.",
    responseReasoning: "I need to provide accurate, up-to-date information about the Federal Reserve interest rate. The last FOMC meeting was in December 2024 where they held rates steady after three consecutive cuts.",
    reasoningTokens: 516,
    providerMetadata: {
      openai: {
        responseId: "resp_seed_gpt54_001",
        serviceTier: "default",
      },
    },
    extraDoProps: {
      "ai.response.msToFirstChunk": 1842.5,
      "ai.response.msToFinish": 7234.8,
      "ai.response.avgOutputTokensPerSecond": 172.8,
    },
  });

  // =====================================================================
  // 19) Cerebras cerebras-gpt-13b — no pricing, no provider cost
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateText",
    doMsg: "ai.generateText.doGenerate",
    system: "cerebras.chat",
    reqModel: "cerebras-gpt-13b",
    respModel: "cerebras-gpt-13b",
    inputTokens: 450,
    outputTokens: 120,
    finishReason: "stop",
    wrapperDurationMs: 600,
    doDurationMs: 400,
    responseText: "The Federal Reserve rate is currently at 4.25-4.50%.",
  });

  // =====================================================================
  // 20) Amazon Bedrock — no pricing in registry
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateText",
    doMsg: "ai.generateText.doGenerate",
    system: "amazon-bedrock",
    reqModel: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    respModel: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    inputTokens: 3200,
    outputTokens: 890,
    finishReason: "stop",
    wrapperDurationMs: 4_000,
    doDurationMs: 3_500,
    responseText: "Based on the latest FOMC statement, the target rate range remains at 4.25% to 4.50%.",
  });

  // =====================================================================
  // 21) Groq — fast inference, no pricing
  // =====================================================================
  addLlmPair({
    wrapperMsg: "ai.generateObject",
    doMsg: "ai.generateObject.doGenerate",
    system: "groq.chat",
    reqModel: "llama-4-scout-17b-16e-instruct",
    respModel: "llama-4-scout-17b-16e-instruct",
    inputTokens: 820,
    outputTokens: 95,
    finishReason: "stop",
    wrapperDurationMs: 300,
    doDurationMs: 200,
    responseObject: JSON.stringify({ rate: "4.25-4.50%", source: "FOMC", date: "2024-12-18" }),
  });

  return events;
}

// ---------------------------------------------------------------------------

seedAiSpans()
  .catch((e) => {
    console.error("Seed failed:");
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
