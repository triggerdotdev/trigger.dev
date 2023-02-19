import { getTriggerRun } from "@trigger.dev/sdk";
import { CreateRecordsInput, CreateRecordsOutput, DeleteRecordInput, DeleteRecordOutput, DeleteRecordsInput, DeleteRecordsOutput, GetRecordInput, GetRecordOutput, ListRecordsInput, ListRecordsOutput, UpdateRecordInput, UpdateRecordOutput, UpdateRecordsInput, UpdateRecordsOutput } from "./types";

/** Create up to 10 records */
export async function createRecords(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: CreateRecordsInput
): Promise<CreateRecordsOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call createRecords outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "airtable",
    endpoint: "createRecords",
    params,
  });

  return output;
}

/** Delete a single record. */
export async function deleteRecord(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: DeleteRecordInput
): Promise<DeleteRecordOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call deleteRecord outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "airtable",
    endpoint: "deleteRecord",
    params,
  });

  return output;
}

/** Delete more than one records with the given record IDs. Note you can't delete a single record with this. */
export async function deleteRecords(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: DeleteRecordsInput
): Promise<DeleteRecordsOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call deleteRecords outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "airtable",
    endpoint: "deleteRecords",
    params,
  });

  return output;
}

/** Retrieve a single record. Any "empty" fields (e.g. "", [], or false) in the record will not be returned. */
export async function getRecord(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: GetRecordInput
): Promise<GetRecordOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getRecord outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "airtable",
    endpoint: "getRecord",
    params,
  });

  return output;
}

/** List records in a table. Note that table names and table ids can be used interchangeably. We recommend using table IDs so you don't need to modify your API request when your table name changes.

      The server returns one page of records at a time. Each page will contain pageSize records, which is 100 by default. If there are more records, the response will contain an offset. To fetch the next page of records, include offset in the next request's parameters. Pagination will stop when you've reached the end of your table. If the maxRecords parameter is passed, pagination will stop once you've reached this maximum.

      Returned records do not include any fields with "empty" values, e.g. "", [], or false. */
export async function listRecords(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: ListRecordsInput
): Promise<ListRecordsOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call listRecords outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "airtable",
    endpoint: "listRecords",
    params,
  });

  return output;
}

/** Updates a single record. */
export async function updateRecord(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: UpdateRecordInput
): Promise<UpdateRecordOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call updateRecord outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "airtable",
    endpoint: "updateRecord",
    params,
  });

  return output;
}

/** Updates up to 10 records, or upserts them when performUpsert is set. */
export async function updateRecords(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: UpdateRecordsInput
): Promise<UpdateRecordsOutput> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call updateRecords outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "airtable",
    endpoint: "updateRecords",
    params,
  });

  return output;
}
