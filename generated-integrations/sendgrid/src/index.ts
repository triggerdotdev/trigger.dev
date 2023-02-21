import { getTriggerRun } from "@trigger.dev/sdk";
import { MailSendInput, MarketingContactsInput, MarketingContactsOutput } from "./types";

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

/** Add or update (up to 30k) contacts. Contacts are queued and aren't created immediately. */
export async function marketingContacts(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: MarketingContactsInput
): Promise<MarketingContactsOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call marketingContacts outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "sendgrid",
    endpoint: "marketingContacts",
    params,
  });

  return output;
}
