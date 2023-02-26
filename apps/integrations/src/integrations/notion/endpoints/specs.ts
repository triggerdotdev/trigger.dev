import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";
import {
  CreatePageParameters,
  CreatePageResponse,
} from "./schemas/endpoints/createPage";
import { GetPageResponse } from "./schemas/endpoints/getPage";
import { GetUserResponse } from "./schemas/endpoints/getUser";
import { ListUsersResponse } from "./schemas/endpoints/listUsers";
import { GetSelfResponse } from "./schemas/endpoints/me";
import { SearchParameters, SearchResponse } from "./schemas/endpoints/search";
import { VersionHeaderParam } from "./schemas/params";

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
    oauth: [],
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
        schema: GetUserResponse,
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
    oauth: [],
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
    oauth: [],
  },
  parameters: [VersionHeaderParam],
  request: {},
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: GetSelfResponse,
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
    oauth: [],
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

export const createPage: EndpointSpec = {
  path: "/pages",
  method: "POST",
  metadata: {
    name: "createPage",
    description:
      "Creates a new page that is a child of an existing page or database. If the parent is a page then `title` is the only valid property. If the parent is a database then the `properties` must match the parent database's properties.",
    displayProperties: {
      title: "Create a page",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/post-page",
    },
    tags: ["pages"],
  },
  security: {
    oauth: [],
  },
  parameters: [VersionHeaderParam],
  request: {
    body: {
      schema: CreatePageParameters,
    },
  },
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: CreatePageResponse,
      },
    ],
    default: [errorResponse],
  },
};

export const search: EndpointSpec = {
  path: "/search",
  method: "POST",
  metadata: {
    name: "search",
    description: `Searches all original pages, databases, and child pages/databases that are shared with the integration. It will not return linked databases, since these duplicate their source databases.`,
    displayProperties: {
      title: "Search for ${body.query}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/post-search",
    },
    tags: ["search"],
  },
  security: {
    oauth: [],
  },
  parameters: [VersionHeaderParam],
  request: {
    body: {
      schema: SearchParameters,
    },
  },
  responses: {
    200: [
      {
        success: true,
        name: "Success",
        description: "Typical success response",
        schema: SearchResponse,
      },
    ],
    default: [errorResponse],
  },
};
