import AirtableSDK, { Records, FieldSet } from "airtable";
import { AuthenticatedTask, DisplayProperty } from "@trigger.dev/sdk";

type AirtableSDKClient = InstanceType<typeof AirtableSDK>;

type AirtableAuthenticatedTask<
  TParams extends Record<string, unknown>,
  TResult,
> = AuthenticatedTask<AirtableSDKClient, TParams, TResult>;

type TableParams<Params extends Record<string, unknown>> = {
  baseId: string;
  tableName: string;
} & Params;

export type AirtableRecordsParams = TableParams<{}>;
export type AirtableRecords = Records<FieldSet>;

export const getRecords: AirtableAuthenticatedTask<AirtableRecordsParams, AirtableRecords> = {
  run: async (params, client) => {
    const records = await client.base(params.baseId).table(params.tableName).select().all();
    return records;
  },
  init: (params) => {
    return {
      name: "Get Records",
      params,
      icon: "airtable",
      properties: [...tableParams(params)],
    };
  },
};

function tableParams(params: TableParams<{}>): DisplayProperty[] {
  return [
    {
      label: "Base",
      text: params.baseId,
    },
    {
      label: "Table",
      text: params.tableName,
    },
  ];
}
