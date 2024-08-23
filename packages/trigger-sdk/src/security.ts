import crypto from "node:crypto";
import type { BinaryToTextEncoding, BinaryLike, KeyObject } from "crypto";
import { VerifyResult } from "./types.js";

/** Easily verify webhook payloads when they're using common signing methods. */
export async function verifyRequestSignature({
  request,
  headerName,
  headerEncoding = "hex",
  secret,
  algorithm,
}: {
  /** The web request that you want to verify. */
  request: Request;
  /** The name of the header that contains the signature. E.g. `X-Cal-Signature-256`. */
  headerName: string;
  /** The header encoding. Defaults to `hex`. */
  headerEncoding?: BinaryToTextEncoding;
  /** The secret that you use to hash the payload. For HttpEndpoints this will usually originally
      come from the Trigger.dev dashboard and should be stored in an environment variable. */
  secret: BinaryLike | KeyObject;
  /** The hashing algorithm that was used to create the signature. Currently only `sha256` is
      supported. */
  algorithm: "sha256";
}): Promise<VerifyResult> {
  if (!secret) {
    return {
      success: false,
      reason: "Missing secret – you've probably not set an environment variable.",
    };
  }

  const headerValue = request.headers.get(headerName);
  if (!headerValue) {
    return { success: false, reason: "Missing header" };
  }

  switch (algorithm) {
    case "sha256":
      const success = verifyHmacSha256(headerValue, headerEncoding, secret, await request.text());

      if (success) {
        return {
          success,
        };
      } else {
        return { success: false, reason: "Failed sha256 verification" };
      }
    default:
      throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
}

export function verifyHmacSha256(
  headerValue: string,
  headerEncoding: BinaryToTextEncoding,
  secret: BinaryLike | KeyObject,
  body: string
): boolean {
  const bodyDigest = crypto.createHmac("sha256", secret).update(body).digest(headerEncoding);
  const signature = headerValue?.replace("hmac-sha256=", "").replace("sha256=", "") ?? "";

  return signature === bodyDigest;
}
