import { describe, beforeEach, expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";
import nock from "nock";
const authToken = () => process.env.AIRTABLE_TOKEN ?? "";

describe("airtable.endpoints", async () => {
  beforeEach(async () => {
    nock.cleanAll();
  });

  test("getRecord", async () => {
    nock("https://api.airtable.com")
      .get("/v0/appBlf3KsalIQeMUo/tblvXn2TOeVPC9c6m/recHcnB1MbBr9Rd2P")
      .reply(200, {
        id: "recHcnB1MbBr9Rd2P",
        fields: {
          Name: "John",
          Age: 30,
        },
        createdTime: "2021-06-22T10:02:01.000Z",
      });

    const accessToken = authToken();

    const data = await endpoints.getRecord.request({
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
    expect(data.body).not.toBeNull();
  });
});
