const WORKER_SECRET_PATTERN = /^[a-f0-9]{64}$/;

export async function jobWorkerToken(secret: string | undefined, jobId: string): Promise<string> {
  if (!secret || !WORKER_SECRET_PATTERN.test(secret))
    throw new Error("DEMO_ARTIFACT_SECRET is not configured");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`convex-image-artifact:${jobId}`)
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}
