import type { DeliverEmail } from "emails";
import { commonWorker } from "~/v3/commonWorker.server";

// Lives outside email.server.ts so that the SMTP/Resend client module
// stays a leaf dependency. Pulling commonWorker from email.server poisoned
// every consumer of the auth chain (auth → emailAuth → email) with the
// V1+V2 worker tree, which transitively loads marqs and trips Redis-env
// guards in any vitest file whose import graph reaches it.
export async function scheduleEmail(data: DeliverEmail, delay?: { seconds: number }) {
  const availableAt = delay ? new Date(Date.now() + delay.seconds * 1000) : undefined;
  await commonWorker.enqueue({
    job: "scheduleEmail",
    payload: data,
    availableAt,
  });
}
