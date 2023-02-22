import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";
const authToken = () => process.env.AIRTABLE_TOKEN ?? "";

describe("notion.endpoints", async () => {
  test("getUser", async () => {
    const accessToken = authToken();

    // const nockDone = await startNock("notion.getUser");
    const data = await endpoints.getUser.request({
      parameters: {
        baseId: "appBlf3KsalIQeMUo",
        tableIdOrName: "tblvXn2TOeVPC9c6m",
        recordId: "recHcnB1MbBr9Rd2P",
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: ["data.records:read"],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    // stopNock(nockDone);
  });
});
