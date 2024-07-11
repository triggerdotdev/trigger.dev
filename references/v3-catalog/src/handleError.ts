import { logger, type HandleErrorFunction } from "@trigger.dev/sdk/v3";

export const handleError: HandleErrorFunction = async (
  payload,
  error,
  { ctx, retry, retryAt, retryDelayInMs }
) => {
  logger.log("handling error", { error, retry, retryAt, retryDelayInMs });
};
