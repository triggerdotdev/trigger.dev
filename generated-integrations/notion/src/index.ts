import { getTriggerRun } from "@trigger.dev/sdk";
import { AppendBlockChildrenInput, AppendBlockChildrenOutput, CreateCommentInput, CreateCommentOutput, CreateDatabaseInput, CreateDatabaseOutput, CreatePageInput, CreatePageOutput, DeleteBlockInput, DeleteBlockOutput, GetBlockInput, GetBlockOutput, GetBlockChildrenInput, GetBlockChildrenOutput, GetBotInfoInput, GetBotInfoOutput, GetCommentsInput, GetCommentsOutput, GetDatabaseInput, GetDatabaseOutput, GetPageInput, GetPageOutput, GetUserInput, GetUserOutput, ListUsersInput, ListUsersOutput, QueryDatabaseInput, QueryDatabaseOutput, SearchInput, SearchOutput, UpdateBlockInput, UpdateBlockOutput, UpdateDatabaseInput, UpdateDatabaseOutput, UpdatePageInput, UpdatePageOutput } from "./types";

/** Creates and appends new children blocks to the parent block_id specified. Returns a paginated list of newly created first level children block objects. */
export async function appendBlockChildren(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: AppendBlockChildrenInput
): Promise<AppendBlockChildrenOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call appendBlockChildren outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "appendBlockChildren",
    params,
  });

  return output;
}

/** Creates a comment in a page or existing discussion thread. There are two locations you can add a new comment to:
1. A page
2.An existing discussion thread
 If the intention is to add a new comment to a page, a parent object must be provided in the body params. Alternatively, if a new comment is being added to an existing discussion thread, the discussion_id string must be provided in the body params. Exactly one of these parameters must be provided. */
export async function createComment(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: CreateCommentInput
): Promise<CreateCommentOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call createComment outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "createComment",
    params,
  });

  return output;
}

/** Creates a database as a subpage in the specified parent page, with the specified properties schema. */
export async function createDatabase(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: CreateDatabaseInput
): Promise<CreateDatabaseOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call createDatabase outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "createDatabase",
    params,
  });

  return output;
}

/** Creates a new page that is a child of an existing page or database. If the parent is a page then `title` is the only valid property. If the parent is a database then the `properties` must match the parent database's properties. */
export async function createPage(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: CreatePageInput
): Promise<CreatePageOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call createPage outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "createPage",
    params,
  });

  return output;
}

/** Sets a Block object, including page blocks, to archived: true using the ID specified. Note: in the Notion UI application, this moves the block to the "Trash" where it can still be accessed and restored.

To restore the block with the API, use the Update a block or Update page respectively. */
export async function deleteBlock(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: DeleteBlockInput
): Promise<DeleteBlockOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call deleteBlock outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "deleteBlock",
    params,
  });

  return output;
}

/** Retrieves a Block object using the ID specified. If a block contains the key has_children: true, use the Retrieve block children endpoint to get the list of children */
export async function getBlock(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: GetBlockInput
): Promise<GetBlockOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getBlock outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "getBlock",
    params,
  });

  return output;
}

/** Returns a paginated array of child block objects contained in the block using the ID specified. In order to receive a complete representation of a block, you may need to recursively retrieve the block children of child blocks. */
export async function getBlockChildren(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: GetBlockChildrenInput
): Promise<GetBlockChildrenOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getBlockChildren outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "getBlockChildren",
    params,
  });

  return output;
}

/** Get's the bots info */
export async function getBotInfo(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: GetBotInfoInput
): Promise<GetBotInfoOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getBotInfo outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "getBotInfo",
    params,
  });

  return output;
}

/** Retrieves a list of un-resolved Comment objects from a page or block. */
export async function getComments(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: GetCommentsInput
): Promise<GetCommentsOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getComments outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "getComments",
    params,
  });

  return output;
}

/** Retrieves a Database object using the ID specified.

Note that this won't get "Linked databases" (they have a ↗ next to the database title) – you need the source database id. */
export async function getDatabase(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: GetDatabaseInput
): Promise<GetDatabaseOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getDatabase outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "getDatabase",
    params,
  });

  return output;
}

/** Retrieves a Page object using the ID specified. */
export async function getPage(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: GetPageInput
): Promise<GetPageOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getPage outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "getPage",
    params,
  });

  return output;
}

/** Get a user's information */
export async function getUser(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: GetUserInput
): Promise<GetUserOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getUser outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "getUser",
    params,
  });

  return output;
}

/** Returns a paginated list of Users for the workspace. The response may contain fewer than page_size of results. */
export async function listUsers(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: ListUsersInput
): Promise<ListUsersOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call listUsers outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "listUsers",
    params,
  });

  return output;
}

/** Gets a list of Pages contained in the database, filtered and ordered according to the filter conditions and sort criteria provided in the request. The response may contain fewer than page_size of results. */
export async function queryDatabase(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: QueryDatabaseInput
): Promise<QueryDatabaseOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call queryDatabase outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "queryDatabase",
    params,
  });

  return output;
}

/** Searches all original pages, databases, and child pages/databases that are shared with the integration. It will not return linked databases, since these duplicate their source databases. */
export async function search(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: SearchInput
): Promise<SearchOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call search outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "search",
    params,
  });

  return output;
}

/** Update a block Updates the content for the specified block_id based on the block type. Supported fields based on the block object type. */
export async function updateBlock(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: UpdateBlockInput
): Promise<UpdateBlockOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call updateBlock outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "updateBlock",
    params,
  });

  return output;
}

/** Update the title, description, or properties of a specified database. Sending a request with a properties body param changes the columns of a database. To update a row rather than a column, query the Update page endpoint. To add a new row to a database, call Create a page. */
export async function updateDatabase(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: UpdateDatabaseInput
): Promise<UpdateDatabaseOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call updateDatabase outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "updateDatabase",
    params,
  });

  return output;
}

/** Update a page icon, cover or archived status. You can update a database page's properties but the properties must match the parent database schema. */
export async function updatePage(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: UpdatePageInput
): Promise<UpdatePageOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call updatePage outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "notion",
    endpoint: "updatePage",
    params,
  });

  return output;
}
