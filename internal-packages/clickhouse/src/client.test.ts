import { clickhouseTest } from "@internal/testcontainers";

describe("ClickHouse Client", () => {
  clickhouseTest("should create a client", async ({ clickhouseClient }) => {
    const client = clickhouseClient;

    const result = await client.query({
      query: "SELECT 1",
    });

    const json = await result.json();

    console.log(json);

    expect(json.data).toEqual([{ "1": 1 }]);
  });
});
