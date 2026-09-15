import { logger } from "../utilities/logger.js";

type BuildWorkerLogOptions = {
  target: string;
  branch?: string;
  envVars?: Record<string, string>;
  rewritePaths?: boolean;
  forcedExternals?: string[];
  plain?: boolean;
};

export function logBuildWorkerStart(options: BuildWorkerLogOptions) {
  logger.debug("Starting buildWorker", {
    target: options.target,
    hasBranch: options.branch !== undefined,
    envVarCount: Object.keys(options.envVars ?? {}).length,
    rewritePaths: options.rewritePaths ?? false,
    forcedExternalsCount: options.forcedExternals?.length ?? 0,
    plain: options.plain ?? false,
  });
}
