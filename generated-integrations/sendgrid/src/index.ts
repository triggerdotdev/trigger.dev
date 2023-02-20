import { getTriggerRun } from "@trigger.dev/sdk";
import { MailSendInput } from "./types";

/** Send email to one or more recipients with personalization */
export async function mailSend(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: MailSendInput
): Promise<void> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call mailSend outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "sendgrid",
    endpoint: "mailSend",
    params,
  });

  return output;
}
