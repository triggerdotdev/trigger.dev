import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import { subscribe } from ".";

const authToken = () => process.env.TYPEFORM_API_KEY ?? "";

describe("webhook", async () => {
  test("subscribe", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("notion.getUser");
    const result = await subscribe({
      baseUrl: "https://api.notion.com/v1",
    });

    const data = await endpoints.getUser.request({
      parameters: {
        user_id: "cc18a80a-973f-42c4-8fed-a055f8ae31f4",
        "Notion-Version": notionVersion,
      },
      credentials: {
        type: "oauth2",
        name: "oauth",
        accessToken,
        scopes: [""],
      },
    });

    expect(data.status).toEqual(200);
    expect(data.success).toEqual(true);
    expect(data.body).not.toBeNull();
    stopNock(nockDone);
  });
});
