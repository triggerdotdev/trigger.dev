import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";
import {
  CreatePageParameters,
  CreatePageResponse,
} from "./schemas/endpoints/createPage";
import { GetBlockResponse } from "./schemas/endpoints/getBlock";
import { GetPageResponse } from "./schemas/endpoints/getPage";
import { GetUserResponse } from "./schemas/endpoints/getUser";
import { ListBlockChildrenResponse } from "./schemas/endpoints/listBlockChildren";
import { ListUsersResponse } from "./schemas/endpoints/listUsers";
import { GetSelfResponse } from "./schemas/endpoints/me";
import { SearchParameters, SearchResponse } from "./schemas/endpoints/search";
import {
  UpdateBlockBodyParameters,
  UpdateBlockResponse,
} from "./schemas/endpoints/updateBlock";
import {
  UpdatePageBodyParameters,
  UpdatePageResponse,
} from "./schemas/endpoints/updatePage";
import {
  BlockIdParam,
  PageIdParam,
  PageSizeParam,
  StartCursorParam,
  VersionHeaderParam,
} from "./schemas/params";

const errorResponse: EndpointSpecResponse = {
  matches: ({ statusCode }) => statusCode < 200 || statusCode >= 300,
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
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: GetUserResponse,
    },
    errorResponse,
  ],
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
  parameters: [VersionHeaderParam, StartCursorParam, PageSizeParam],
  request: {},
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: ListUsersResponse,
    },
    errorResponse,
  ],
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
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: GetSelfResponse,
    },
    errorResponse,
  ],
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
    PageIdParam,
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
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: GetPageResponse,
    },
    errorResponse,
  ],
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
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      schema: CreatePageParameters,
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: CreatePageResponse,
    },
    errorResponse,
  ],
};

export const updatePage: EndpointSpec = {
  path: "/pages/{page_id}",
  method: "PATCH",
  metadata: {
    name: "updatePage",
    description:
      "Update a page icon, cover or archived status. You can update a database page's properties but the properties must match the parent database schema.",
    displayProperties: {
      title: "Update page ${parameters.page_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/patch-page",
    },
    tags: ["pages"],
  },
  security: {
    oauth: [],
  },
  parameters: [PageIdParam, VersionHeaderParam],
  request: {
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      schema: UpdatePageBodyParameters,
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: UpdatePageResponse,
    },
    errorResponse,
  ],
};

export const getBlock: EndpointSpec = {
  path: "/blocks/{block_id}",
  method: "GET",
  metadata: {
    name: "getBlock",
    description: `Retrieves a Block object using the ID specified. If a block contains the key has_children: true, use the Retrieve block children endpoint to get the list of children`,
    displayProperties: {
      title: "Get block for block id ${parameters.block_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/retrieve-a-block",
    },
    tags: ["blocks"],
  },
  security: {
    oauth: [],
  },
  parameters: [BlockIdParam, VersionHeaderParam],
  request: {},
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: GetBlockResponse,
    },
    errorResponse,
  ],
};

export const updateBlock: EndpointSpec = {
  path: "/blocks/{block_id}",
  method: "PATCH",
  metadata: {
    name: "updateBlock",
    description:
      "Update a block Updates the content for the specified block_id based on the block type. Supported fields based on the block object type.",
    displayProperties: {
      title: "Update block ${parameters.block_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/update-a-block",
    },
    tags: ["blocks"],
  },
  security: {
    oauth: [],
  },
  parameters: [BlockIdParam, VersionHeaderParam],
  request: {
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      schema: UpdateBlockBodyParameters,
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: UpdateBlockResponse,
    },
    errorResponse,
  ],
};

//todo retrieve block children
export const getBlockChildren: EndpointSpec = {
  path: "/blocks/{block_id}/children",
  method: "GET",
  metadata: {
    name: "getBlockChildren",
    description: `Returns a paginated array of child block objects contained in the block using the ID specified. In order to receive a complete representation of a block, you may need to recursively retrieve the block children of child blocks.`,
    displayProperties: {
      title: "Get block children for block id ${parameters.block_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/get-block-children",
    },
    tags: ["blocks"],
  },
  security: {
    oauth: [],
  },
  parameters: [
    BlockIdParam,
    VersionHeaderParam,
    StartCursorParam,
    PageSizeParam,
  ],
  request: {},
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: ListBlockChildrenResponse,
    },
    errorResponse,
  ],
};
//todo append block children
//todo delete block

//todo get database
//todo query database
//todo create database
//todo Update database

//todo get comments
//todo create comment

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
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: SearchResponse,
    },
    errorResponse,
  ],
};
