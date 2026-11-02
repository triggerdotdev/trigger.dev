import { z } from "zod";
import { jobWorkerToken } from "../shared/workerAuth";

export const workerSchema = z.object({
  serviceUrl: z.string().url(),
  jobId: z.string().min(1),
});
export type Worker = z.infer<typeof workerSchema>;
export type Slot = "prepared" | "edited" | "hero" | "card" | "square";
const TYPES = {
  prepared: "image/jpeg",
  edited: "image/png",
  hero: "image/avif",
  card: "image/avif",
  square: "image/avif",
};
function address(worker: Worker, slot: Slot) {
  return `${worker.serviceUrl}/api/artifacts?jobId=${encodeURIComponent(worker.jobId)}&slot=${slot}`;
}
export async function readArtifact(worker: Worker, slot: Slot) {
  const response = await fetch(address(worker, slot), {
    headers: {
      Authorization: `Bearer ${await jobWorkerToken(process.env.DEMO_ARTIFACT_SECRET, worker.jobId)}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Temporary image could not be read: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
export async function saveArtifact(worker: Worker, slot: Slot, data: Uint8Array) {
  const response = await fetch(address(worker, slot), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await jobWorkerToken(process.env.DEMO_ARTIFACT_SECRET, worker.jobId)}`,
      "Content-Type": TYPES[slot],
    },
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Temporary image could not be saved: HTTP ${response.status}`);
}
