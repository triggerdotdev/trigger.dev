import { ActionArgs, LoaderArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger";
import { workerQueue } from "~/services/worker.server";
import { safeJsonParse } from "~/utils/json";

const ParamsSchema = z.object({
  environmentId: z.string(),
  endpointSlug: z.string(),
  indexHookIdentifier: z.string(),
});

export async function loader({ params }: LoaderArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return {
      status: 400,
      json: {
        error: "Invalid params",
      },
    };
  }

  const { environmentId, endpointSlug, indexHookIdentifier } =
    parsedParams.data;

  const service = new TriggerEndpointIndexHookService();

  await service.call({
    environmentId,
    endpointSlug,
    indexHookIdentifier,
  });

  return json({
    ok: true,
  });
}

export async function action({ request, params }: ActionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return {
      status: 400,
      json: {
        error: "Invalid params",
      },
    };
  }

  const { environmentId, endpointSlug, indexHookIdentifier } =
    parsedParams.data;

  const body = await request.text();

  const service = new TriggerEndpointIndexHookService();

  await service.call({
    environmentId,
    endpointSlug,
    indexHookIdentifier,
    body: body ? safeJsonParse(body) : undefined,
  });

  return json({
    ok: true,
  });
}

type TriggerEndpointDeployHookOptions = z.infer<typeof ParamsSchema> & {
  body?: any;
};

export class TriggerEndpointIndexHookService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environmentId,
    endpointSlug,
    indexHookIdentifier,
    body,
  }: TriggerEndpointDeployHookOptions) {
    logger.debug("TriggerEndpointIndexHookService.call", {
      environmentId,
      endpointSlug,
      indexHookIdentifier,
      body,
    });

    const endpoint = await this.#prismaClient.endpoint.findUnique({
      where: {
        environmentId_slug: {
          environmentId,
          slug: endpointSlug,
        },
      },
    });

    if (!endpoint) {
      throw new Error("Endpoint not found");
    }

    if (endpoint.indexingHookIdentifier !== indexHookIdentifier) {
      throw new Error("Index hook identifier is invalid");
    }

    const reason = parseReasonFromBody(body);

    // Index the endpoint in 5 seconds from now
    await workerQueue.enqueue(
      "indexEndpoint",
      {
        id: endpoint.id,
        source: "HOOK",
        reason,
        sourceData: body,
      },
      {
        runAt: new Date(Date.now() + 5000),
      }
    );
  }
}

function parseReasonFromBody(body: any): string | undefined {
  const vercelDeployment = VercelDeploymentWebhookSchema.safeParse(body);

  if (!vercelDeployment.success) {
    return;
  }

  const { payload, type } = vercelDeployment.data;

  if (type !== "deployment.succeeded") {
    return;
  }

  const githubMeta = VercelDeploymentGithubMetaSchema.safeParse(
    payload.deployment.meta
  );

  if (!githubMeta.success) {
    return `Vercel project ${payload.deployment.name} was deployed to ${payload.deployment.url}`;
  }

  return `"${githubMeta.data.githubCommitMessage}" was deployed from ${
    githubMeta.data.githubCommitRef
  } (${githubMeta.data.githubCommitSha.slice(0, 7)}) to ${
    payload.deployment.name
  }`;
}

// Example payload: https://jsonhero.io/j/fhIwXEFmi7qa
const VercelDeploymentWebhookSchema = z.object({
  id: z.string(),
  payload: z.object({
    user: z.object({
      id: z.string(),
    }),
    team: z.object({
      id: z.string(),
    }),
    deployment: z.object({
      id: z.string(),
      meta: z.record(z.any()),
      name: z.string(),
      url: z.string(),
      inspectorUrl: z.string(),
    }),
    links: z.object({
      deployment: z.string(),
      project: z.string(),
    }),
    name: z.string(),
    plan: z.string(),
    project: z.object({
      id: z.string(),
    }),
    regions: z.array(z.string()),
    target: z.string(),
    type: z.string(),
    url: z.string(),
  }),
  createdAt: z.number(),
  type: z.enum([
    "deployment.succeeded",
    "deployment.failed",
    "deployment.ready",
    "deployment.created",
    "deployment.error",
    "deployment.canceled",
  ]),
});

const VercelDeploymentGithubMetaSchema = z.object({
  githubCommitAuthorName: z.string(),
  githubCommitMessage: z.string(),
  githubCommitOrg: z.string(),
  githubCommitRef: z.string(),
  githubCommitRepo: z.string(),
  githubCommitSha: z.string(),
  githubDeployment: z.string(),
  githubOrg: z.string(),
  githubRepo: z.string(),
  githubRepoOwnerType: z.string(),
  githubCommitRepoId: z.string(),
  githubRepoId: z.string(),
  githubRepoVisibility: z.string(),
  githubCommitAuthorLogin: z.string(),
  branchAlias: z.string(),
});
