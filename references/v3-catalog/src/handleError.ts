import { logger, type HandleErrorFunction } from "@trigger.dev/sdk/v3";

export const handleError: HandleErrorFunction = async (payload, error, { ctx, retry }) => {
  logger.log("handling error", { error });
};
