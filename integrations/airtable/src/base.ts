import { DisplayProperty, IOWithIntegrations, IntegrationTaskKey } from "@trigger.dev/sdk";
import { FieldSet, Records, SelectOptions } from "airtable";
import { AirtableFieldSet, AirtableRecord, AirtableRunTask, CreateAirtableRecord } from ".";
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
        return result.map((record) => toSerializableRecord<TFields>(record));
      },
      {
        name: "Get Records",
        params,
        properties: [...tableParams({ baseId: this.baseId, tableName: this.tableName })],
      }
    );
  }

  getRecord(key: IntegrationTaskKey, recordId: string) {
    return this.runTask(
      key,
      async (client) => {
        const result = await client.base(this.baseId).table<TFields>(this.tableName).find(recordId);
        return toSerializableRecord<TFields>(result);
      },
      {
        name: "Get Record",
        params: { recordId },
        properties: [
          ...tableParams({ baseId: this.baseId, tableName: this.tableName }),
          { label: "Record", text: recordId },
        ],
      }
    );
  }

  createRecords(key: IntegrationTaskKey, records: Partial<TFields>[]) {
    return this.runTask(
      key,
      async (client) => {
        const result = await client
          .base(this.baseId)
          .table<TFields>(this.tableName)
          .create(records.map((record) => ({ fields: record })));
        return result.map((record) => toSerializableRecord<TFields>(record));
      },
      {
        name: "Create Records",
        params: records,
        properties: [
          ...tableParams({ baseId: this.baseId, tableName: this.tableName }),
          { label: "Records", text: records.length.toString() },
        ],
      }
    );
  }
}

function toSerializableRecord<TFields extends AirtableFieldSet>(record: AirtableRecord<TFields>) {
  return {
    id: record.id,
    fields: record.fields,
    commentCount: record.commentCount,
  } as AirtableRecord<TFields>;
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
