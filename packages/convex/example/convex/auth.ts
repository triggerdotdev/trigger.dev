import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export async function ownedEdit(
  ctx: Pick<QueryCtx, "db">,
  jobId: Id<"edits">,
  sessionToken: string
) {
  const owner = await ownerHash(sessionToken);
  const job = await ctx.db.get(jobId);
  if (!job || job.ownerHash !== owner || job.expiresAt <= Date.now())
    throw new Error("Job not found");
  return job;
}

export async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function ownerHash(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid browser session");
  return digest(token);
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
