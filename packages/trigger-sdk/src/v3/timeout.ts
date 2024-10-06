import { timeout as timeoutApi } from "@trigger.dev/core/v3";

const MAXIMUM_MAX_DURATION = 2_147_483_647;

export const timeout = {
  None: MAXIMUM_MAX_DURATION,
  signal: timeoutApi.signal,
};
