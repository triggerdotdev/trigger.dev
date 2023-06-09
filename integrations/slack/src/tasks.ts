import { clientFactory } from "./client";
import type { AuthenticatedTask } from "@trigger.dev/sdk";

type SlackClientType = ReturnType<typeof clientFactory>;

export const postMessage: AuthenticatedTask<
  ReturnType<typeof clientFactory>,
  { text: string; channel: string },
  Awaited<ReturnType<SlackClientType["chat"]["postMessage"]>>
> = {
  run: async (params, client) => {
    return client.chat.postMessage({
      text: params.text,
      channel: params.channel,
      link_names: true,
    });
  },
  init: (params) => {
    return {
      name: "Post Message",
      params,
      icon: "slack",
      properties: [
        {
          label: "Channel ID",
          text: params.channel,
        },
        {
          label: "Message",
          text: params.text,
        },
      ],
    };
  },
};
