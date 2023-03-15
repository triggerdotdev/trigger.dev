import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";
import {
  AppendBlockChildrenBodyParameters,
  AppendBlockChildrenResponse,
} from "./schemas/endpoints/appendBlockChildren";
import {
  CreateCommentBodyParameters,
  CreateCommentResponse,
} from "./schemas/endpoints/createComment";
import {
  CreateDatabaseBodyParameters,
  CreateDatabaseResponse,
} from "./schemas/endpoints/createDatabase";
import {
  CreatePageParameters,
  CreatePageResponse,
} from "./schemas/endpoints/createPage";
import { DeleteBlockResponse } from "./schemas/endpoints/deleteBlock";
import { GetBlockResponse } from "./schemas/endpoints/getBlock";
import { GetDatabaseResponse } from "./schemas/endpoints/getDatabase";
import { GetPageResponse } from "./schemas/endpoints/getPage";
import { GetUserResponse } from "./schemas/endpoints/getUser";
import { ListBlockChildrenResponse } from "./schemas/endpoints/listBlockChildren";
import { ListCommentsResponse } from "./schemas/endpoints/listComments";
import { ListUsersResponse } from "./schemas/endpoints/listUsers";
import { GetSelfResponse } from "./schemas/endpoints/me";
import {
  QueryDatabaseBodyParameters,
  QueryDatabaseQueryParameters,
  QueryDatabaseResponse,
} from "./schemas/endpoints/queryDatabase";
import { SearchParameters, SearchResponse } from "./schemas/endpoints/search";
import {
  UpdateBlockBodyParameters,
  UpdateBlockResponse,
} from "./schemas/endpoints/updateBlock";
import {
  UpdateDatabaseBodyParameters,
  UpdateDatabaseResponse,
} from "./schemas/endpoints/updateDatabase";
import {
  UpdatePageBodyParameters,
  UpdatePageResponse,
} from "./schemas/endpoints/updatePage";
import {
  BlockIdParam,
  DatabaseIdParam,
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
  schema: undefined,
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
      schema: "#/definitions/user_id_path",
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
      schema: "#/definitions/get_user_response",
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
      schema: "#/definitions/list_users_response",
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
      url: "https://developers.notion.com/reference/get-self",
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
      schema: "#/definitions/get_bot_info_response",
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
      schema: "#/definitions/filter_properties_path",
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
      schema: "#/definitions/get_page_response",
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
      schema: "#/definitions/create_page_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/create_page_response",
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
      schema: "#/definitions/update_page_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/update_page_response",
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
      schema: "#/definitions/get_block_response",
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
      schema: "#/definitions/update_block_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/update_block_response",
    },
    errorResponse,
  ],
};

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
      schema: "#/definitions/get_block_children_response",
    },
    errorResponse,
  ],
};

export const appendBlockChildren: EndpointSpec = {
  path: "/blocks/{block_id}/children",
  method: "PATCH",
  metadata: {
    name: "appendBlockChildren",
    description: `Creates and appends new children blocks to the parent block_id specified. Returns a paginated list of newly created first level children block objects.`,
    displayProperties: {
      title: "Append new blocks to parent block id ${parameters.block_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/patch-block-children",
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
      schema: "#/definitions/append_block_children_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/append_block_children_response",
    },
    errorResponse,
  ],
};

export const deleteBlock: EndpointSpec = {
  path: "/blocks/{block_id}",
  method: "DELETE",
  metadata: {
    name: "deleteBlock",
    description: `Sets a Block object, including page blocks, to archived: true using the ID specified. Note: in the Notion UI application, this moves the block to the "Trash" where it can still be accessed and restored.\n\nTo restore the block with the API, use the Update a block or Update page respectively.`,
    displayProperties: {
      title: "Delete block with block id ${parameters.block_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/delete-a-block",
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
      schema: "#/definitions/delete_block_response",
    },
    errorResponse,
  ],
};

export const getDatabase: EndpointSpec = {
  path: "/databases/{database_id}",
  method: "GET",
  metadata: {
    name: "getDatabase",
    description: `Retrieves a Database object using the ID specified.\n\nNote that this won't get "Linked databases" (they have a ↗ next to the database title) – you need the source database id.`,
    displayProperties: {
      title: "Get database with id ${parameters.database_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/retrieve-a-database",
    },
    tags: ["database"],
  },
  security: {
    oauth: [],
  },
  parameters: [DatabaseIdParam, VersionHeaderParam],
  request: {},
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/get_database_response",
    },
    errorResponse,
  ],
};

export const queryDatabase: EndpointSpec = {
  path: "/databases/{database_id}/query",
  method: "POST",
  metadata: {
    name: "queryDatabase",
    description: `Gets a list of Pages contained in the database, filtered and ordered according to the filter conditions and sort criteria provided in the request. The response may contain fewer than page_size of results.`,
    displayProperties: {
      title: "Query database with id ${parameters.database_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/post-database-query",
    },
    tags: ["database"],
  },
  security: {
    oauth: [],
  },
  parameters: [
    DatabaseIdParam,
    VersionHeaderParam,
    {
      name: "filter_properties",
      in: "query",
      description:
        "The list of database properties you want to receive back in the responses – you need to provide ids",
      schema: "#/definitions/filter_properties_query",
    },
  ],
  request: {
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      schema: "#/definitions/query_database_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/query_database_response",
    },
    errorResponse,
  ],
};

export const createDatabase: EndpointSpec = {
  path: "/databases",
  method: "POST",
  metadata: {
    name: "createDatabase",
    description: `Creates a database as a subpage in the specified parent page, with the specified properties schema.`,
    displayProperties: {
      title: "Create database",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/create-a-database",
    },
    tags: ["database"],
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
      schema: "#/definitions/create_database_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/create_database_response",
    },
    errorResponse,
  ],
};

export const updateDatabase: EndpointSpec = {
  path: "/databases/{database_id}",
  method: "PATCH",
  metadata: {
    name: "updateDatabase",
    description: `Update the title, description, or properties of a specified database. Sending a request with a properties body param changes the columns of a database. To update a row rather than a column, query the Update page endpoint. To add a new row to a database, call Create a page.`,
    displayProperties: {
      title: "Update database with id ${parameters.database_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/update-a-database",
    },
    tags: ["database"],
  },
  security: {
    oauth: [],
  },
  parameters: [DatabaseIdParam, VersionHeaderParam],
  request: {
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      schema: "#/definitions/update_database_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/update_database_response",
    },
    errorResponse,
  ],
};

export const getComments: EndpointSpec = {
  path: "/comments",
  method: "GET",
  metadata: {
    name: "getComments",
    description: `Retrieves a list of un-resolved Comment objects from a page or block.`,
    displayProperties: {
      title: "Get comments for block id ${parameters.block_id}",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/retrieve-a-comment",
    },
    tags: ["comments"],
  },
  security: {
    oauth: [],
  },
  parameters: [
    {
      name: "block_id",
      in: "query",
      description: "ID of the block",
      schema: "#/definitions/block_id_query",
      required: true,
    },
    StartCursorParam,
    PageSizeParam,
    VersionHeaderParam,
  ],
  request: {},
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/get_comments_response",
    },
    errorResponse,
  ],
};

export const createComment: EndpointSpec = {
  path: "/comments",
  method: "POST",
  metadata: {
    name: "createComment",
    description: `Creates a comment in a page or existing discussion thread. There are two locations you can add a new comment to:\n1. A page\n2.An existing discussion thread\n If the intention is to add a new comment to a page, a parent object must be provided in the body params. Alternatively, if a new comment is being added to an existing discussion thread, the discussion_id string must be provided in the body params. Exactly one of these parameters must be provided.`,
    displayProperties: {
      title: "Create comment",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://developers.notion.com/reference/create-a-comment",
    },
    tags: ["comments"],
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
      schema: "#/definitions/create_comment_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/create_comment_response",
    },
    errorResponse,
  ],
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
      schema: "#/definitions/search_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Typical success response",
      schema: "#/definitions/search_response",
    },
    errorResponse,
  ],
};
