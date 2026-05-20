import { logger } from "~/services/logger.server";

export type ReadFallbackInput = {
  runId: string;
  environmentId: string;
  organizationId: string;
};

export async function findRunByIdWithMollifierFallback(
  input: ReadFallbackInput,
): Promise<null> {
  logger.debug("mollifier read-fallback called (phase 1 stub)", {
    runId: input.runId,
  });
  return null;
}
