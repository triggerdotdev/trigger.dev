import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";
import { schemaFromOpenApiSpecV2 } from "core/schemas/openApi";
import { spec } from "./schemas/spec";

const errorResponse: EndpointSpecResponse = {
  matches: ({ statusCode, body }) => statusCode !== 200 || !body.ok,
  success: false,
  name: "Error",
  description: "200 error response",
  schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      ok: {
        type: "boolean",
        enum: [false],
      },
      error: {
        type: "string",
      },
    },
    required: ["ok", "error"],
  },
};

export const chatPostMessage: EndpointSpec = {
  path: "/chat.postMessage",
  method: "POST",
  metadata: {
    name: "postMessage",
    description: "Post a message to a channel",
    displayProperties: {
      title: "Post message to ${body.channel}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://api.slack.com/methods/chat.postMessage",
    },
    tags: ["chat"],
  },
  security: {
    slackAuth: ["chat:write:user", "chat:write:bot"],
  },
  request: {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: {
      schema: {
        type: "object",
        required: ["channel"],
        properties: {
          as_user: {
            type: "string",
            description:
              "Pass true to post the message as the authed user, instead of as a bot. Defaults to false. See [authorship](#authorship) below.",
          },
          attachments: {
            type: "string",
            description:
              "A JSON-based array of structured attachments, presented as a URL-encoded string.",
          },
          blocks: {
            type: "string",
            description:
              "A JSON-based array of structured blocks, presented as a URL-encoded string.",
          },
          channel: {
            type: "string",
            description:
              "Channel, private group, or IM channel to send message to. Can be an encoded ID, or a name. See [below](#channels) for more details.",
          },
          icon_emoji: {
            type: "string",
            description:
              "Emoji to use as the icon for this message. Overrides `icon_url`. Must be used in conjunction with `as_user` set to `false`, otherwise ignored. See [authorship](#authorship) below.",
          },
          icon_url: {
            type: "string",
            description:
              "URL to an image to use as the icon for this message. Must be used in conjunction with `as_user` set to false, otherwise ignored. See [authorship](#authorship) below.",
          },
          link_names: {
            type: "boolean",
            description: "Find and link channel names and usernames.",
          },
          mrkdwn: {
            type: "boolean",
            description:
              "Disable Slack markup parsing by setting to `false`. Enabled by default.",
          },
          parse: {
            type: "string",
            description:
              "Change how messages are treated. Defaults to `none`. See [below](#formatting).",
          },
          reply_broadcast: {
            type: "boolean",
            description:
              "Used in conjunction with `thread_ts` and indicates whether reply should be made visible to everyone in the channel or conversation. Defaults to `false`.",
          },
          text: {
            type: "string",
            description:
              "How this field works and whether it is required depends on other fields you use in your API call. [See below](#text_usage) for more detail.",
          },
          thread_ts: {
            type: "string",
            description:
              "Provide another message's `ts` value to make this message a reply. Avoid using a reply's `ts` value; use its parent instead.",
          },
          unfurl_links: {
            type: "boolean",
            description:
              "Pass true to enable unfurling of primarily text-based content.",
          },
          unfurl_media: {
            type: "boolean",
            description: "Pass false to disable unfurling of media content.",
          },
          username: {
            type: "string",
            description:
              "Set your bot's user name. Must be used in conjunction with `as_user` set to false, otherwise ignored. See [authorship](#authorship) below.",
          },
        },
      },
    },
  },
  responses: [
    {
      matches: ({ statusCode, body }) => statusCode === 200 && body.ok,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: {
        type: "object",
        properties: {
          channel: {
            description: "Channel ID where the message was posted",
            type: "string",
          },
          message: {
            type: "object",
            properties: {
              attachments: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    fallback: {
                      type: "string",
                    },
                    id: {
                      type: "number",
                    },
                    text: {
                      type: "string",
                    },
                  },
                  required: ["fallback", "id", "text"],
                },
              },
              bot_id: {
                type: "string",
              },
              subtype: {
                type: "string",
              },
              text: {
                type: "string",
              },
              ts: {
                type: "string",
              },
              type: {
                type: "string",
              },
              user: {
                type: "string",
              },
            },
            required: ["bot_id", "text", "ts", "type"],
          },
          ok: {
            type: "boolean",
          },
          ts: {
            type: "string",
          },
        },
        required: ["channel", "message", "ok", "ts"],
      },
    },
    errorResponse,
  ],
};

export const conversationsList: EndpointSpec = {
  path: "/conversations.list",
  method: "GET",
  metadata: {
    name: "conversationsList",
    description: "Lists all channels in a Slack team.",
    displayProperties: {
      title: "List channels",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://api.slack.com/methods/conversations.list",
    },
    tags: ["conversations"],
  },
  security: {
    slackAuth: ["conversations:read"],
  },
  parameters: [
    {
      name: "exclude_archived",
      in: "query",
      description: "Set to `true` to exclude archived channels from the list",
      schema: {
        type: "boolean",
      },
    },
    {
      name: "types",
      in: "query",
      description:
        "Mix and match channel types by providing a comma-separated list of any combination of `public_channel`, `private_channel`, `mpim`, `im`",
      schema: {
        type: "string",
      },
    },
    {
      name: "limit",
      in: "query",
      description:
        "The maximum number of items to return. Fewer than the requested number of items may be returned, even if the end of the list hasn't been reached. Must be an integer no larger than 1000.",
      schema: {
        type: "number",
      },
    },
    {
      name: "cursor",
      in: "query",
      description:
        'Paginate through collections of data by setting the `cursor` parameter to a `next_cursor` attribute returned by a previous request\'s `response_metadata`. Default value fetches the first "page" of the collection. See [pagination](/docs/pagination) for more detail.',
      schema: {
        type: "string",
      },
    },
  ],
  request: {},
  responses: [
    {
      matches: ({ statusCode, body }) => statusCode === 200 && body.ok,
      success: true,
      name: "Success",
      schema: schemaFromOpenApiSpecV2(
        spec,
        "/paths//conversations.list/get/responses/200/schema"
      ),
    },
    errorResponse,
    {
      matches: () => true,
      success: false,
      name: "Error",
      schema: schemaFromOpenApiSpecV2(
        spec,
        "/paths//conversations.list/get/responses/default/schema"
      ),
    },
  ],
};

export const conversationsJoin: EndpointSpec = {
  path: "/conversations.join",
  method: "POST",
  metadata: {
    name: "conversationsJoin",
    description: "Joins an existing conversation.",
    displayProperties: {
      title: "Join ${body.channel}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://api.slack.com/methods/conversations.join",
    },
    tags: ["conversations"],
  },
  security: {
    slackAuth: ["channels:write"],
  },
  request: {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: {
      schema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "ID of conversation to join",
          },
        },
        required: ["channel"],
      },
    },
  },
  responses: [
    {
      matches: ({ statusCode, body }) => statusCode === 200 && body.ok,
      success: true,
      name: "Success",
      schema: schemaFromOpenApiSpecV2(
        spec,
        "/paths//conversations.join/post/responses/200/schema"
      ),
    },
    errorResponse,
    {
      matches: () => true,
      success: false,
      name: "Error",
      schema: schemaFromOpenApiSpecV2(
        spec,
        "/paths//conversations.join/post/responses/default/schema"
      ),
    },
  ],
};
