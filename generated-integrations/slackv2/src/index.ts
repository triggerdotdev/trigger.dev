import { getTriggerRun } from "@trigger.dev/sdk";
import { PostMessageInput, PostMessageOutput, ConversationsListInput, ConversationsListOutput } from "./types";

/** Post a message to a channel */
export async function postMessage(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: PostMessageInput
): Promise<PostMessageOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call postMessage outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "slackv2",
    endpoint: "postMessage",
    params,
  });

  return output;
}

/** Lists all channels in a Slack team. */
export async function conversationsList(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: ConversationsListInput
): Promise<ConversationsListOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call conversationsList outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "slackv2",
    endpoint: "conversationsList",
    params,
  });

  return output;
}
