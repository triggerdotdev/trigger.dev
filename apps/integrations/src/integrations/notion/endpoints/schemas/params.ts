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

export const PageIdParam: EndpointSpecParameter = {
  name: "page_id",
  in: "path",
  description: "ID of the page you would like info about",
  schema: {
    type: "string",
  },
  required: true,
};
