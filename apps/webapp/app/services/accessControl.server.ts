import { z } from "zod";
import { ApiAuthenticationResult } from "./apiAuth.server";

export const ClaimsSchema = z.object({
  permissions: z.array(z.string()).optional(),
});

export function permittedToReadRun(
  authenticationResult: ApiAuthenticationResult,
  runId: string
): boolean {
  if (authenticationResult.type === "PRIVATE") {
    return true;
  }

  if (authenticationResult.type === "PUBLIC") {
    return true;
  }

  if (!authenticationResult.claims) {
    return false;
  }

  const parsedClaims = ClaimsSchema.safeParse(authenticationResult.claims);

  if (!parsedClaims.success) {
    return false;
  }

  if (parsedClaims.data.permissions?.includes("read:runs")) {
    return true;
  }

  if (parsedClaims.data.permissions?.includes(`read:runs:${runId}`)) {
    return true;
  }

  if (parsedClaims.data.permissions?.includes(runId)) {
    return true;
  }

  return false;
}

export function permittedToReadRunTag(
  authenticationResult: ApiAuthenticationResult,
  tagName: string
): boolean {
  if (authenticationResult.type === "PRIVATE") {
    return true;
  }

  if (authenticationResult.type === "PUBLIC") {
    return true;
  }

  if (!authenticationResult.claims) {
    return false;
  }

  const parsedClaims = ClaimsSchema.safeParse(authenticationResult.claims);

  if (!parsedClaims.success) {
    return false;
  }

  if (parsedClaims.data.permissions?.includes("read:runs")) {
    return true;
  }

  if (parsedClaims.data.permissions?.includes(`read:tags:${tagName}`)) {
    return true;
  }

  return false;
}

export function permittedToReadBatch(
  authenticationResult: ApiAuthenticationResult,
  batchId: string
): boolean {
  if (authenticationResult.type === "PRIVATE") {
    return true;
  }

  if (authenticationResult.type === "PUBLIC") {
    return true;
  }

  if (!authenticationResult.claims) {
    return false;
  }

  const parsedClaims = ClaimsSchema.safeParse(authenticationResult.claims);

  if (!parsedClaims.success) {
    return false;
  }

  if (parsedClaims.data.permissions?.includes("read:runs")) {
    return true;
  }

  if (parsedClaims.data.permissions?.includes(`read:batches:${batchId}`)) {
    return true;
  }

  if (parsedClaims.data.permissions?.includes(batchId)) {
    return true;
  }

  return false;
}
