import { customEvent, Trigger } from "@trigger.dev/sdk";
import * as airtable from "@trigger.dev/airtable";
import { z } from "zod";

new Trigger({
  id: "airtable-get-record",
  name: "Airtable getRecord",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: customEvent({
    name: "airtable.start",
    schema: z.object({}),
  }),
  run: async (event, ctx) => {
    const record = await airtable.getRecord("get-record", {
      baseId: "appBlf3KsalIQeMUo",
      tableIdOrName: "tblvXn2TOeVPC9c6m",
      recordId: "recHcnB1MbBr9Rd2P",
    });
  },
}).listen();
