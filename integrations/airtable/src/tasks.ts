import AirtableSDK, { Records, FieldSet } from "airtable";
import {
  DisplayProperty,
  IO,
  IOWithIntegrations,
  IntegrationTaskKey,
  IntegrationTasks,
} from "@trigger.dev/sdk";

type AirtableSDKClient = InstanceType<typeof AirtableSDK>;

type TableParams<Params extends Record<string, unknown>> = {
  tableName: string;
} & Params;

export type AirtableRecordsParams = TableParams<{}>;
export type AirtableRecords = Records<FieldSet>;

export class Tasks implements IntegrationTasks<AirtableSDKClient> {
  io: IO;
  client: AirtableSDKClient;

  constructor(io: IO, client: AirtableSDKClient) {
    this.io = io;
    this.client = client;
  }

  base(baseId: string) {
    return {
      table: <TableFields extends FieldSet = FieldSet>(tableName: string) => {
        return {
          getRecords: (key: IntegrationTaskKey, params: {}) => {
            return this.io.runTask(
              key,
              {
                name: "Get Records",
                params,
                icon: "airtable",
                properties: [...tableParams({ baseId, tableName })],
              },
              async () => {
                const records = await this.client
                  .base(baseId)
                  .table<TableFields>(tableName)
                  .select()
                  .all();
                return records;
              }
            );
          },
        };
      },
    };
  }
}

// export const base = (baseId: string) => {
//   return {
//     table: <TableFields extends FieldSet = FieldSet>(tableName: string) => {
//       return {
//         getRecords: (key: IntegrationTaskKey, params: {}, io: IOWithIntegrations<any>) => {
//           return io.runTask(
//             key,
//             {
//               name: "Get Records",
//               params,
//               icon: "airtable",
//               properties: [...tableParams({ baseId, tableName })],
//             },
//             async (task) => {
//               const records = await io.airtable.tasks
//                 .base(baseId)
//                 .table<TableFields>(tableName)
//                 .select()
//                 .all();
//               return records;
//             }
//           );
//         },
//       };
//     },
//   };
// };

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
