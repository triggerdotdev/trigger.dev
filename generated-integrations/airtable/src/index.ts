import { getTriggerRun } from "@trigger.dev/sdk";
import { GetRecordInput, GetRecordOutput } from "./types";

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
