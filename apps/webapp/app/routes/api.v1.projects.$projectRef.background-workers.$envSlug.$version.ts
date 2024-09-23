import { LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  authenticateProjectApiKeyOrPersonalAccessToken,
  authenticatedEnvironmentForAuthentication,
} from "~/services/apiAuth.server";
import zlib from "node:zlib";

const ParamsSchema = z.object({
  projectRef: z.string(),
  envSlug: z.string(),
  version: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  const authenticationResult = await authenticateProjectApiKeyOrPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environment = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    parsedParams.data.projectRef,
    parsedParams.data.envSlug
  );

  // Find the background worker and tasks and files
  const backgroundWorker = await prisma.backgroundWorker.findFirst({
    where: {
      runtimeEnvironmentId: environment.id,
      version: parsedParams.data.version,
    },
    include: {
      tasks: true,
      files: {
        include: {
          tasks: {
            select: {
              slug: true,
            },
          },
        },
      },
    },
  });

  if (!backgroundWorker) {
    return json({ error: "Background worker not found" }, { status: 404 });
  }

  return json({
    id: backgroundWorker.friendlyId,
    version: backgroundWorker.version,
    cliVersion: backgroundWorker.cliVersion,
    sdkVersion: backgroundWorker.sdkVersion,
    contentHash: backgroundWorker.contentHash,
    createdAt: backgroundWorker.createdAt,
    updatedAt: backgroundWorker.updatedAt,
    tasks: backgroundWorker.tasks.map((task) => ({
      id: task.slug,
      exportName: task.exportName,
      filePath: task.filePath,
      source: task.triggerSource,
      retryConfig: task.retryConfig,
      queueConfig: task.queueConfig,
    })),
    files: backgroundWorker.files.map((file) => ({
      id: file.friendlyId,
      filePath: file.filePath,
      contentHash: file.contentHash,
      contents: decompressContent(file.contents),
      tasks: Array.from(new Set(file.tasks.map((task) => task.slug))),
    })),
  });
}

function decompressContent(compressedBuffer: Buffer): string {
  // First, we need to decode the base64 Buffer to get the actual compressed data
  const decodedBuffer = Buffer.from(compressedBuffer.toString("utf-8"), "base64");

  // Decompress the data
  const decompressedData = zlib.inflateSync(decodedBuffer);

  // Convert the decompressed data to string
  return decompressedData.toString();
}
