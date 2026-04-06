import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { z } from "zod";
import { env } from "~/env.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import {
  getRunsReplicationGlobal,
  setRunsReplicationGlobal,
} from "~/services/runsReplicationGlobal.server";

const CreateRunReplicationServiceParams = z.object({
  name: z.string(),
  keepAliveEnabled: z.boolean(),
  keepAliveIdleSocketTtl: z.number(),
  maxOpenConnections: z.number(),
  maxFlushConcurrency: z.number(),
  flushIntervalMs: z.number(),
  flushBatchSize: z.number(),
  leaderLockTimeoutMs: z.number(),
  leaderLockExtendIntervalMs: z.number(),
  leaderLockAcquireAdditionalTimeMs: z.number(),
  leaderLockRetryIntervalMs: z.number(),
  ackIntervalSeconds: z.number(),
  waitForAsyncInsert: z.boolean(),
});

type CreateRunReplicationServiceParams = z.infer<typeof CreateRunReplicationServiceParams>;

export async function action({ request }: ActionFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  if (!user.admin) {
    return json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  try {
    const globalService = getRunsReplicationGlobal();

    if (globalService) {
      return json(
        { error: "Global runs replication service already exists. Stop it first." },
        { status: 400 }
      );
    }

    const params = CreateRunReplicationServiceParams.parse(await request.json());

    await clickhouseFactory.isReady();

    const service = createRunReplicationService(params);

    setRunsReplicationGlobal(service);

    await service.start();

    return json({
      success: true,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}

function createRunReplicationService(params: CreateRunReplicationServiceParams) {
  const {
    name,
    maxFlushConcurrency,
    flushIntervalMs,
    flushBatchSize,
    leaderLockTimeoutMs,
    leaderLockExtendIntervalMs,
    leaderLockAcquireAdditionalTimeMs,
    leaderLockRetryIntervalMs,
    ackIntervalSeconds,
    waitForAsyncInsert,
  } = params;

  const service = new RunsReplicationService({
    clickhouseFactory,
    pgConnectionUrl: env.DATABASE_URL,
    serviceName: name,
    slotName: env.RUN_REPLICATION_SLOT_NAME,
    publicationName: env.RUN_REPLICATION_PUBLICATION_NAME,
    redisOptions: {
      keyPrefix: "runs-replication:",
      port: env.RUN_REPLICATION_REDIS_PORT ?? undefined,
      host: env.RUN_REPLICATION_REDIS_HOST ?? undefined,
      username: env.RUN_REPLICATION_REDIS_USERNAME ?? undefined,
      password: env.RUN_REPLICATION_REDIS_PASSWORD ?? undefined,
      enableAutoPipelining: true,
      ...(env.RUN_REPLICATION_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    maxFlushConcurrency,
    flushIntervalMs,
    flushBatchSize,
    leaderLockTimeoutMs,
    leaderLockExtendIntervalMs,
    leaderLockAcquireAdditionalTimeMs,
    leaderLockRetryIntervalMs,
    ackIntervalSeconds,
    logLevel: "debug",
    waitForAsyncInsert,
  });

  return service;
}
