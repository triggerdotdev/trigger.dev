import crypto from "crypto";
import { VerifyResult } from "./types";

export async function verifyRequestSignature({
  request,
  headerName,
  secret,
  algorithm,
}: {
  request: Request;
  headerName: string;
  secret: string;
  algorithm: "sha256";
}): Promise<VerifyResult> {
  const headerValue = request.headers.get(headerName);
  if (!headerValue) {
    return { success: false, reason: "Missing header" };
  }

  switch (algorithm) {
    case "sha256":
      const success = verifyHmacSha256(headerValue, secret, await request.text());

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

export function verifyHmacSha256(headerValue: string, secret: string, body: string): boolean {
  const signature = headerValue.replace("sha256=", "");
  const buffer = Buffer.from(signature, "utf8");
  const hmac = crypto.createHmac("sha256", secret ?? "");
  const digest = Buffer.from("sha256" + "=" + hmac.update(body).digest("hex"), "utf8");

  const lengthEqual = signature.length === digest.length;
  const isAllowed = lengthEqual && crypto.timingSafeEqual(digest, buffer);

  return isAllowed;
}
