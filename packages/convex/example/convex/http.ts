import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const CONTENT_TYPES = {
  prepared: "image/jpeg",
  edited: "image/png",
  hero: "image/avif",
  card: "image/avif",
  square: "image/avif",
} as const;
const DEV_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://localhost:5173",
  "http://localhost:5174",
];
const http = httpRouter();

const artifact = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin");
  const allowed = [process.env.CONVEX_SITE_URL, ...DEV_ORIGINS];
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    Vary: "Authorization, Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin && !allowed.includes(origin)) return new Response(null, { status: 403, headers });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    return new Response(null, { status: 204, headers });
  }
  const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return new Response(null, { status: 401, headers });
  const url = new URL(request.url);
  const slot = url.searchParams.get("slot");
  const jobId = url.searchParams.get("jobId") as Id<"edits"> | null;
  if (!slot || !Object.hasOwn(CONTENT_TYPES, slot) || !jobId)
    return new Response(null, { status: 404, headers });
  const kind = slot as keyof typeof CONTENT_TYPES;
  const write = request.method === "POST";
  let access;
  try {
    access = await ctx.runQuery(internal.jobs.fileAccess, { jobId, token, slot: kind, write });
  } catch {
    return new Response(null, { status: 404, headers });
  }
  if (!access) return new Response(null, { status: 404, headers });
  if (!write) {
    const blob = access.storageId ? await ctx.storage.get(access.storageId) : null;
    if (!blob) return new Response(null, { status: 404, headers });
    headers.set("Content-Type", CONTENT_TYPES[kind]);
    headers.set(
      "Content-Disposition",
      `inline; filename="${kind}.${kind === "prepared" ? "jpg" : kind === "edited" ? "png" : "avif"}"`
    );
    return new Response(blob, { headers });
  }
  if (request.headers.get("Content-Type") !== CONTENT_TYPES[kind])
    return new Response(null, { status: 415, headers });
  if (Number(request.headers.get("Content-Length")) > MAX_ARTIFACT_BYTES)
    return new Response(null, { status: 413, headers });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      return new Response(null, { status: 413, headers });
    }
    chunks.push(new Uint8Array(value));
  }
  if (!length) return new Response(null, { status: 400, headers });
  const blob = new Blob(chunks, { type: CONTENT_TYPES[kind] });
  // A process failure between storage and registration is recovered by the storage sweep.
  const storageId = await ctx.storage.store(blob);
  try {
    if (
      !(await ctx.runMutation(internal.jobs.registerFile, { jobId, token, slot: kind, storageId }))
    ) {
      await ctx.storage.delete(storageId);
      return new Response(null, { status: 410, headers });
    }
  } catch {
    await ctx.storage.delete(storageId);
    return new Response(null, { status: 503, headers });
  }
  return new Response(null, { status: 201, headers });
});

http.route({ path: "/image", method: "GET", handler: artifact });
http.route({ path: "/image", method: "OPTIONS", handler: artifact });
http.route({ path: "/artifacts", method: "POST", handler: artifact });
http.route({ path: "/artifacts", method: "GET", handler: artifact });
http.route({ path: "/artifacts", method: "OPTIONS", handler: artifact });
export default http;
