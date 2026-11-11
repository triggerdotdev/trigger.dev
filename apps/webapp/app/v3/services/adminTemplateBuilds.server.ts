import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma as defaultPrisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { selectTemplateBuildDeployments } from "./templateBuildSelection.server";
import {
  type TemplateBuildRequestResult,
  TemplatePrebuildService,
} from "./templatePrebuild.server";

const MAX_SELECTED_DEPLOYMENTS = 200;
const HEARTBEAT_MS = 15_000;

export const TemplateBuildsBodySchema = z
  .object({
    // Deployment ids, friendly ids or short codes.
    deploymentIds: z.array(z.string().min(1)).min(1).max(50).optional(),
    organizationId: z.string().min(1).optional(),
    organizationSlug: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    projectRef: z.string().min(1).optional(),
    environmentTypes: z
      .array(z.enum(["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"]))
      .min(1)
      .optional(),
    includeRecent: z.number().int().min(0).max(20).optional(),
    force: z.boolean().default(false),
    wait: z.boolean().default(true),
  })
  .strict()
  .superRefine((body, ctx) => {
    const selector = body.organizationId !== undefined || body.organizationSlug !== undefined;
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if ((body.deploymentIds !== undefined) === selector) {
      issue("Pass either deploymentIds or organizationId/organizationSlug");
    }
    if (body.organizationId !== undefined && body.organizationSlug !== undefined) {
      issue("Pass organizationId or organizationSlug, not both");
    }
    if (body.projectId !== undefined && body.projectRef !== undefined) {
      issue("Pass projectId or projectRef, not both");
    }
    if (
      !selector &&
      (body.projectId !== undefined ||
        body.projectRef !== undefined ||
        body.environmentTypes !== undefined ||
        body.includeRecent !== undefined)
    ) {
      issue("projectId, projectRef, environmentTypes and includeRecent need an organization");
    }
  });

export type TemplateBuildsBody = z.infer<typeof TemplateBuildsBodySchema>;

/** Runs the admin template-builds request for an already validated body. */
export async function adminTemplateBuilds(
  body: TemplateBuildsBody,
  {
    prisma = defaultPrisma,
    service = new TemplatePrebuildService(),
    waitTimeoutMs = env.TEMPLATE_BUILDER_ADMIN_TIMEOUT_MS,
  }: {
    prisma?: PrismaClientOrTransaction;
    service?: TemplatePrebuildService;
    waitTimeoutMs?: number;
  } = {}
): Promise<Response> {
  const { deploymentIds: requestedIds, force, wait, ...selector } = body;

  let deploymentIds: string[];
  let currentIds: Set<string> | undefined;
  if (requestedIds) {
    deploymentIds = [...new Set(requestedIds)];
  } else {
    const selection = await selectTemplateBuildDeployments(prisma, selector);
    if (!selection.ok) {
      return json({ error: selection.error }, { status: 404 });
    }
    if (selection.deployments.length > MAX_SELECTED_DEPLOYMENTS) {
      return json(
        {
          error: `The selector matched ${selection.deployments.length} deployments, more than ${MAX_SELECTED_DEPLOYMENTS}; narrow it`,
        },
        { status: 400 }
      );
    }
    deploymentIds = selection.deployments.map((d) => d.deploymentId);
    currentIds = new Set(selection.deployments.filter((d) => d.current).map((d) => d.deploymentId));
  }

  const withCurrent = (result: TemplateBuildRequestResult) =>
    currentIds ? { ...result, current: currentIds.has(result.deploymentId) } : result;
  const log = (results: TemplateBuildRequestResult[]) =>
    logger.info("Admin template builds requested", {
      count: deploymentIds.length,
      force,
      wait,
      selector: requestedIds ? undefined : selector,
      results,
    });

  if (!wait) {
    const results = await service.requestBuilds({ deploymentIds, force });
    log(results);
    return json({ results: results.map(withCurrent) });
  }

  return templateBuildStream((onResult) =>
    service
      .requestBuilds({
        deploymentIds,
        force,
        timeoutMs: waitTimeoutMs,
        onResult: (result) => onResult(withCurrent(result)),
      })
      .then((results) => {
        log(results);
        return results.map(withCurrent);
      })
  );
}

/**
 * Streams NDJSON: a `{"result": ...}` line as each build settles, then one `{"results": [...]}`
 * line with the same shape as the `wait: false` response. Blank lines keep idle proxies open.
 */
export function templateBuildStream<T>(
  run: (onResult: (result: T) => void) => Promise<T[]>,
  heartbeatMs = HEARTBEAT_MS
): Response {
  const encoder = new TextEncoder();
  let open = true;
  let heartbeat: NodeJS.Timeout | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: string) => {
        if (open) controller.enqueue(encoder.encode(line));
      };
      heartbeat = setInterval(() => write("\n"), heartbeatMs);
      run((result) => write(`${JSON.stringify({ result })}\n`))
        .then((results) => write(`${JSON.stringify({ results })}\n`))
        .catch((error) => {
          logger.error("Admin template builds failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          write(`${JSON.stringify({ error: "Internal server error" })}\n`);
        })
        .finally(() => {
          clearInterval(heartbeat);
          if (open) {
            open = false;
            controller.close();
          }
        });
    },
    // The client went away; the builds carry on and store their keys.
    cancel() {
      open = false;
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}
