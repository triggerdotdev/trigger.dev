import { DisplayProperty, IOWithIntegrations, IntegrationTaskKey } from "@trigger.dev/sdk";
import { FieldSet, Records, SelectOptions } from "airtable";
import { AirtableFieldSet, AirtableRunTask } from ".";
import { QueryParams } from "airtable/lib/query_params";

type TableParams<Params extends Record<string, unknown>> = {
  tableName: string;
} & Params;

export type AirtableRecordsParams = TableParams<{}>;
export type AirtableRecords = Records<FieldSet>;

export class Base {
  runTask: AirtableRunTask;
  baseId: string;

  constructor(runTask: AirtableRunTask, baseId: string) {
    this.runTask = runTask;
    this.baseId = baseId;
  }

  table<TFields extends AirtableFieldSet>(tableName: string) {
    return new Table<TFields>(this.runTask, this.baseId, tableName);
  }
}

export class Table<TFields extends AirtableFieldSet> {
  runTask: AirtableRunTask;
  baseId: string;
  tableName: string;

  constructor(runTask: AirtableRunTask, baseId: string, tableName: string) {
    this.runTask = runTask;
    this.baseId = baseId;
    this.tableName = tableName;
  }

  getRecords(key: IntegrationTaskKey, params?: SelectOptions<TFields>) {
    return this.runTask(
      key,
      async (client) => {
        const result = await client
          .base(this.baseId)
          .table<TFields>(this.tableName)
          .select(params)
          .all();
        const fields = result.map((record) => record.fields);
        return fields as TFields[];
      },
      {
        name: "Get Records",
        params,
        icon: "airtable",
        properties: [...tableParams({ baseId: this.baseId, tableName: this.tableName })],
      }
    );
  }
}

function tableParams(params: { baseId: string; tableName: string }): DisplayProperty[] {
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
