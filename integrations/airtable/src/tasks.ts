import { AuthenticatedTask } from "@trigger.dev/sdk";
import type { AirtableSDK, RecordParams, RecordResponse } from "./types";

export const getRecords: AuthenticatedTask<AirtableSDK, RecordParams, RecordResponse> = {
  run: async (params, client) => {
    const records = await client.table(params.table).select().all();
    return records;
  },
  init: (params) => {
    return {
      name: "Get Records",
      params,
      icon: "airtable",
      properties: [
        {
          label: "Table",
          text: params.table,
        },
      ],
    };
  },
};
