import type { HandleErrorFunction } from "@trigger.dev/sdk/v3";

export const handleError: HandleErrorFunction = async (payload, error, { ctx, retry }) => {
  console.log("GOT TO handleError FUNCTION");
};
