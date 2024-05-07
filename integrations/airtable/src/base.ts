import { DisplayProperty, IntegrationTaskKey } from "@trigger.dev/sdk";
import AirtableSDK from "airtable";
import { AirtableFieldSet, AirtableRecord, AirtableRunTask } from ".";

type TableParams<Params extends Record<string, unknown>> = {
  tableName: string;
} & Params;

export type AirtableRecordsParams = TableParams<{}>;
export type AirtableRecords = AirtableSDK.Records<AirtableSDK.FieldSet>;

export class Base {
  constructor(
    private runTask: AirtableRunTask,
    public baseId: string
  ) {}

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

  getRecords(key: IntegrationTaskKey, params?: AirtableSDK.SelectOptions<TFields>) {
    return this.runTask(
      key,
      async (client) => {
        const result = await client
          .base(this.baseId)
          // official types are wrong - we need to use our extended AirtableFieldSet here
          // @ts-ignore
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
        // official types are wrong - we need to use our extended AirtableFieldSet here
        // @ts-ignore
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

  createRecords(key: IntegrationTaskKey, records: { fields: Partial<TFields> }[]) {
    return this.runTask(
      key,
      async (client) => {
        const result = await client
          .base(this.baseId)
          // official types are wrong - we need to use our extended AirtableFieldSet here
          // @ts-ignore
          .table<TFields>(this.tableName)
          .create(records);
        return result.map((record) => toSerializableRecord<TFields>(record));
      },
      {
        name: "Create Records",
        params: records,
        properties: [
          ...tableParams({ baseId: this.baseId, tableName: this.tableName }),
          { label: "Created records", text: records.length.toString() },
        ],
      }
    );
  }

  updateRecords(key: IntegrationTaskKey, records: { id: string; fields: Partial<TFields> }[]) {
    return this.runTask(
      key,
      async (client) => {
        const result = await client
          .base(this.baseId)
          // official types are wrong - we need to use our extended AirtableFieldSet here
          // @ts-ignore
          .table<TFields>(this.tableName)
          .update(records);
        return result.map((record) => toSerializableRecord<TFields>(record));
      },
      {
        name: "Update Records",
        params: records,
        properties: [
          ...tableParams({ baseId: this.baseId, tableName: this.tableName }),
          { label: "Updated records", text: records.length.toString() },
        ],
      }
    );
  }

  deleteRecords(key: IntegrationTaskKey, recordIds: string[]) {
    return this.runTask(
      key,
      async (client) => {
        const result = await client
          .base(this.baseId)
          // official types are wrong - we need to use our extended AirtableFieldSet here
          // @ts-ignore
          .table<TFields>(this.tableName)
          .destroy(recordIds);
        return result.map((record) => toSerializableRecord<TFields>(record));
      },
      {
        name: "Delete Records",
        params: { recordIds },
        properties: [
          ...tableParams({ baseId: this.baseId, tableName: this.tableName }),
          { label: "Deleted records", text: recordIds.length.toString() },
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
