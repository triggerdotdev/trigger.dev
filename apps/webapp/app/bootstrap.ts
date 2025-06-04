import { mkdir, writeFile } from "fs/promises";
import { prisma } from "./db.server";
import { env } from "./env.server";
import { WorkerGroupService } from "./v3/services/worker/workerGroupService.server";
import { dirname } from "path";
import { tryCatch } from "@trigger.dev/core";

export async function bootstrap() {
  if (env.TRIGGER_BOOTSTRAP_ENABLED !== "1") {
    return;
  }

  if (env.TRIGGER_BOOTSTRAP_WORKER_GROUP_NAME) {
    const [error] = await tryCatch(createWorkerGroup());
    if (error) {
      console.error("Failed to create worker group", { error });
    }
  }
}

async function createWorkerGroup() {
  const workerGroupName = env.TRIGGER_BOOTSTRAP_WORKER_GROUP_NAME;
  const tokenPath = env.TRIGGER_BOOTSTRAP_WORKER_TOKEN_PATH;

  const existingWorkerGroup = await prisma.workerInstanceGroup.findFirst({
    where: {
      name: workerGroupName,
    },
  });

  if (existingWorkerGroup) {
    console.warn(`[bootstrap] Worker group ${workerGroupName} already exists`);
    return;
  }

  const service = new WorkerGroupService();
  const { token, workerGroup } = await service.createWorkerGroup({
    name: workerGroupName,
  });

  console.log(`
==========================
Trigger.dev Bootstrap - Worker Token

WARNING: This will only be shown once. Save it now!

Worker group:
${workerGroup.name}

Token:
${token.plaintext}

If using docker compose, set:
TRIGGER_WORKER_TOKEN=${token.plaintext}

${
  tokenPath
    ? `Or, if using a file:
TRIGGER_WORKER_TOKEN=file://${tokenPath}`
    : ""
}

==========================
  `);

  if (tokenPath) {
    const dir = dirname(tokenPath);
    await mkdir(dir, { recursive: true });
    await writeFile(tokenPath, token.plaintext, {
      mode: 0o600,
    });

    console.log(`[bootstrap] Worker token saved to ${tokenPath}`);
  }
}
