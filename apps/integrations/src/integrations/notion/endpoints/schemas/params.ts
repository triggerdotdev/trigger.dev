import { EndpointSpecParameter } from "core/endpoint/types";

export const VersionHeaderParam: EndpointSpecParameter = {
  name: "Notion-Version",
  in: "header",
  description:
    "The Notion API is versioned. Our API versions are named for the date the version is released, for example, 2022-06-28",
  schema: {
    type: "string",
  },
  required: true,
};

export const StartCursorParam: EndpointSpecParameter = {
  name: "start_cursor",
  in: "query",
  description:
    "The cursor to start from. If not provided, the default is to start from the beginning of the list.",
  schema: {
    type: "string",
  },
  required: false,
};

export const PageSizeParam: EndpointSpecParameter = {
  name: "page_size",
  in: "query",
  description: "The number of results to return. The maximum is 100.",
  schema: {
    type: "integer",
  },
  required: false,
};

export const PageIdParam: EndpointSpecParameter = {
  name: "page_id",
  in: "path",
  description: "ID of the page",
  schema: {
    type: "string",
  },
  required: true,
};

export const BlockIdParam: EndpointSpecParameter = {
  name: "block_id",
  in: "path",
  description: "ID of the block",
  schema: {
    type: "string",
  },
  required: true,
};

export const DatabaseIdParam: EndpointSpecParameter = {
  name: "database_id",
  in: "path",
  description: "ID of the database",
  schema: {
    type: "string",
  },
  required: true,
};
