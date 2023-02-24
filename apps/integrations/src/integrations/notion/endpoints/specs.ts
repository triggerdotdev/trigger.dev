import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";
import { GetPageResponse } from "./schemas/page";
import { VersionHeaderParam } from "./schemas/params";
import { ListUsersResponse, UserObjectResponse } from "./schemas/person";

const errorResponse: EndpointSpecResponse = {
  success: false,
  name: "Error",
  description: "Error response",
  schema: {},
};

export const getUser: EndpointSpec = {
  path: "/users/{user_id}",
  method: "GET",
  metadata: {
    name: "getUser",
    description: `Get a user's information`,
    displayProperties: {
      title: "Get user info for user id ${parameters.user_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/get-user",
    },
    tags: ["users"],
  },
  security: {
    api_key: [],
  },
  parameters: [
    {
      name: "user_id",
      in: "path",
      description: "ID of the user you would like info about",
      schema: {
        type: "string",
      },
      required: true,
    },
    VersionHeaderParam,
  ],
  request: {},
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: UserObjectResponse,
      },
    ],
    default: [errorResponse],
  },
};

export const listUsers: EndpointSpec = {
  path: "/users",
  method: "GET",
  metadata: {
    name: "listUsers",
    description: `Returns a paginated list of Users for the workspace. The response may contain fewer than page_size of results.`,
    displayProperties: {
      title: "List users",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/get-users",
    },
    tags: ["users"],
  },
  security: {
    api_key: [],
  },
  parameters: [
    VersionHeaderParam,
    {
      name: "start_cursor",
      in: "query",
      description:
        "The cursor to start from. If not provided, the default is to start from the beginning of the list.",
      schema: {
        type: "string",
      },
      required: false,
    },
    {
      name: "page_size",
      in: "query",
      description: "The number of results to return. The maximum is 100.",
      schema: {
        type: "integer",
      },
      required: false,
    },
  ],
  request: {},
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: ListUsersResponse,
      },
    ],
    default: [errorResponse],
  },
};

export const getBotInfo: EndpointSpec = {
  path: "/users/me",
  method: "GET",
  metadata: {
    name: "getBotInfo",
    description: `Get's the bots info`,
    displayProperties: {
      title: "Get the bot's info",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/get-users",
    },
    tags: ["users"],
  },
  security: {
    api_key: [],
  },
  parameters: [VersionHeaderParam],
  request: {},
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: UserObjectResponse,
      },
    ],
    default: [errorResponse],
  },
};

export const getPage: EndpointSpec = {
  path: "/pages/{page_id}",
  method: "GET",
  metadata: {
    name: "getPage",
    description: `Retrieves a Page object using the ID specified.`,
    displayProperties: {
      title: "Get the page info for page id ${parameters.page_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/retrieve-a-page",
    },
    tags: ["pages"],
  },
  security: {
    api_key: [],
  },
  parameters: [
    {
      name: "page_id",
      in: "path",
      description: "ID of the page you would like info about",
      schema: {
        type: "string",
      },
      required: true,
    },
    VersionHeaderParam,
    {
      name: "filter_properties",
      in: "query",
      description: "The properties to filter by",
      schema: {
        type: "array",
        items: {
          description: "The property to filter by",
          type: "string",
        },
      },
      required: false,
    },
  ],
  request: {},
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: GetPageResponse,
      },
    ],
    default: [errorResponse],
  },
};
