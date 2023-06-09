import { authenticatedTask } from "@trigger.dev/sdk";
import { clientFactory } from "./client";

export const postMessage = authenticatedTask({
  run: async (
    params: { text: string; channel: string },
    client: ReturnType<typeof clientFactory>,
    task,
    io
  ) => {
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
});
