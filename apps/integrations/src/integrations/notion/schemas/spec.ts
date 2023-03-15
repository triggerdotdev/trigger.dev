import { IntegrationSchema } from "core/schemas/types";
import {
  AppendBlockChildrenBodyParameters,
  AppendBlockChildrenResponse,
} from "../endpoints/schemas/endpoints/appendBlockChildren";
import {
  CreateCommentBodyParameters,
  CreateCommentResponse,
} from "../endpoints/schemas/endpoints/createComment";
import {
  CreateDatabaseBodyParameters,
  CreateDatabaseResponse,
} from "../endpoints/schemas/endpoints/createDatabase";
import {
  CreatePageParameters,
  CreatePageResponse,
} from "../endpoints/schemas/endpoints/createPage";
import { DeleteBlockResponse } from "../endpoints/schemas/endpoints/deleteBlock";
import { GetBlockResponse } from "../endpoints/schemas/endpoints/getBlock";
import { GetDatabaseResponse } from "../endpoints/schemas/endpoints/getDatabase";
import { GetPageResponse } from "../endpoints/schemas/endpoints/getPage";
import { GetUserResponse } from "../endpoints/schemas/endpoints/getUser";
import { ListBlockChildrenResponse } from "../endpoints/schemas/endpoints/listBlockChildren";
import { ListCommentsResponse } from "../endpoints/schemas/endpoints/listComments";
import { ListUsersResponse } from "../endpoints/schemas/endpoints/listUsers";
import { GetSelfResponse } from "../endpoints/schemas/endpoints/me";
import {
  QueryDatabaseBodyParameters,
  QueryDatabaseResponse,
} from "../endpoints/schemas/endpoints/queryDatabase";
import {
  SearchParameters,
  SearchResponse,
} from "../endpoints/schemas/endpoints/search";
import {
  UpdateBlockBodyParameters,
  UpdateBlockResponse,
} from "../endpoints/schemas/endpoints/updateBlock";
import {
  UpdateDatabaseBodyParameters,
  UpdateDatabaseResponse,
} from "../endpoints/schemas/endpoints/updateDatabase";
import {
  UpdatePageBodyParameters,
  UpdatePageResponse,
} from "../endpoints/schemas/endpoints/updatePage";

export const spec: IntegrationSchema = {
  definitions: {
    version_header: {
      type: "string",
    },
    start_cursor_query: {
      type: "string",
    },
    page_size_query: {
      type: "integer",
    },
    user_id_path: {
      type: "string",
    },
    page_id_path: {
      type: "string",
    },
    block_id_path: {
      type: "string",
    },
    database_id_path: {
      type: "string",
    },
    filter_properties_path: {
      type: "array",
      items: {
        description: "The property to filter by",
        type: "string",
      },
    },
    filter_properties_query: {
      type: "array",
      items: {
        type: "string",
      },
    },
    block_id_query: {
      type: "string",
    },
    get_user_response: GetUserResponse,
    list_users_response: ListUsersResponse,
    get_bot_info_response: GetSelfResponse,
    get_page_response: GetPageResponse,
    create_page_request_body: CreatePageParameters,
    create_page_response: CreatePageResponse,
    update_page_request_body: UpdatePageBodyParameters,
    update_page_response: UpdatePageResponse,
    get_block_response: GetBlockResponse,
    update_block_request_body: UpdateBlockBodyParameters,
    update_block_response: UpdateBlockResponse,
    get_block_children_response: ListBlockChildrenResponse,
    append_block_children_request_body: AppendBlockChildrenBodyParameters,
    append_block_children_response: AppendBlockChildrenResponse,
    delete_block_response: DeleteBlockResponse,
    get_database_response: GetDatabaseResponse,
    query_database_request_body: QueryDatabaseBodyParameters,
    query_database_response: QueryDatabaseResponse,
    create_database_request_body: CreateDatabaseBodyParameters,
    create_database_response: CreateDatabaseResponse,
    update_database_request_body: UpdateDatabaseBodyParameters,
    update_database_response: UpdateDatabaseResponse,
    get_comments_response: ListCommentsResponse,
    create_comment_request_body: CreateCommentBodyParameters,
    create_comment_response: CreateCommentResponse,
    search_request_body: SearchParameters,
    search_response: SearchResponse,
  },
};
