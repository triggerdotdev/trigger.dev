import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import endpoints from "../endpoints/endpoints";
const authToken = () => process.env.AIRTABLE_TOKEN ?? "";

describe("airtable.endpoints", async () => {
  test("listRecords simple", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("airtable.listRecords.simple");
    const data = await endpoints.listRecords.request({
      parameters: {
        baseId: "appBlf3KsalIQeMUo",
        tableIdOrName: "tblvXn2TOeVPC9c6m",
      },
      body: {},
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
    stopNock(nockDone);
  });

  test("listRecords advanced", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("airtable.listRecords.advanced");
    const data = await endpoints.listRecords.request({
      parameters: {
        baseId: "appBlf3KsalIQeMUo",
        tableIdOrName: "tblvXn2TOeVPC9c6m",
      },
      body: {
        timeZone: "America/Los_Angeles",
        userLocale: "en",
        sort: [
          {
            field: "Employee",
            direction: "asc",
          },
        ],
        fields: ["Employee"],
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
    stopNock(nockDone);
  });

  test("getRecord", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("airtable.getRecord");
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
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("updateRecords", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("airtable.updateRecords");
    const data = await endpoints.updateRecords.request({
      parameters: {
        baseId: "appBlf3KsalIQeMUo",
        tableIdOrName: "tblvXn2TOeVPC9c6m",
      },
      body: {
        records: [
          {
            id: "recHcnB1MbBr9Rd2P",
            fields: {
              Employee: "John Doe",
            },
          },
        ],
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: ["data.records:write"],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("upsertRecords", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("airtable.upsertRecords");
    const data = await endpoints.updateRecords.request({
      parameters: {
        baseId: "appBlf3KsalIQeMUo",
        tableIdOrName: "tblvXn2TOeVPC9c6m",
      },
      body: {
        performUpsert: {
          fieldsToMergeOn: ["Employee"],
        },
        records: [
          {
            fields: {
              Employee: "John Doe",
            },
          },
          {
            fields: {
              Employee: "Jane Doe",
            },
          },
        ],
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: ["data.records:write"],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });

  test("updateRecord", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("airtable.updateRecord");
    const data = await endpoints.updateRecord.request({
      parameters: {
        baseId: "appBlf3KsalIQeMUo",
        tableIdOrName: "tblvXn2TOeVPC9c6m",
        recordId: "recHcnB1MbBr9Rd2P",
      },
      body: {
        fields: {
          Employee: "John Doe II",
        },
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: ["data.records:write"],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });
});
