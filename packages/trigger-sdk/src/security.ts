import crypto from "crypto";

export async function verifyRequestSignature({
  request,
  headerName,
  secret,
  algorithm = "sha256",
}: {
  request: Request;
  headerName: string;
  secret?: string;
  algorithm?: "sha256";
}): Promise<boolean> {
  const headerValue = request.headers.get(headerName);
  if (!headerValue) {
    return false;
  }

  if (!secret) {
    return false;
  }

  switch (algorithm) {
    case "sha256":
      return verifyHmacSha256(headerValue, secret, await request.text());
    default:
      throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
}

export function verifyHmacSha256(headerValue: string, secret: string, body: string): boolean {
  const signature = headerValue.replace("sha256=", "");
  const buffer = Buffer.from(signature, "utf8");
  const hmac = crypto.createHmac("sha256", secret ?? "");
  const digest = Buffer.from("sha256" + "=" + hmac.update(body).digest("hex"), "utf8");

  const isAllowed = signature.length === digest.length && crypto.timingSafeEqual(digest, buffer);

  return isAllowed;
}
