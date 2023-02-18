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

  // test("listRecords advanced", async () => {
  //   const accessToken = authToken();

  //   const nockDone = await startNock("airtable.listRecords.advanced", true);
  //   const data = await endpoints.listRecords.request({
  //     parameters: {
  //       baseId: "appBlf3KsalIQeMUo",
  //       tableIdOrName: "tblvXn2TOeVPC9c6m",
  //     },
  //     body: {
  //       timeZone: "America/Los_Angeles",
  //       userLocale: "en",
  //       pageSize: 1,
  //       maxRecords: 1,
  //       offset: "itrHrzqGgjB3mwKgX/rec3cPi3z4s6oe9SD",
  //     },
  //     credentials: {
  //       type: "oauth2",
  //       name: "oauth",
  //       accessToken,
  //       scopes: ["data.records:read"],
  //     },
  //   });

  //   // console.log(JSON.stringify(data, null, 2));

  //   expect(data.status).toEqual(200);
  //   expect(data.success).toEqual(true);
  //   expect(data.body).not.toBeNull();
  //   stopNock(nockDone);
  // });

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
});
