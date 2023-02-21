import { authentication } from "integrations/airtable/authentication";
import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import { serviceFetch } from "./serviceFetch";
const authToken = () => process.env.AIRTABLE_TOKEN ?? "";

describe("serviceFetch", async () => {
  test("simple GET", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("serviceFetch.simple.get");
    const response = await serviceFetch({
      url: "https://api.airtable.com/v0/appBlf3KsalIQeMUo/tblvXn2TOeVPC9c6m/recHcnB1MbBr9Rd2P",
      method: "GET",
      authentication: authentication,
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: ["data.records:read"],
      },
    });

    expect(response.status).toEqual(200);
    expect(response.success).toEqual(true);
    expect(response.body).not.toBeNull();
    stopNock(nockDone);
  });
});
