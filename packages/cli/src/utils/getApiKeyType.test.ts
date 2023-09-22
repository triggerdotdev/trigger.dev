import { checkApiKeyIsDevServer } from "./getApiKeyType";

describe("Test API keys", () => {
  test("dev server succeeds", async () => {
    const result = checkApiKeyIsDevServer("tr_dev_12345");
    expect(result.success).toEqual(true);
  });

  test("dev public fails", async () => {
    const result = checkApiKeyIsDevServer("pk_dev_12345");
    expect(result.success).toEqual(false);
    if (result.success) return;
    expect(result.type?.environment).toEqual("dev");
    expect(result.type?.type).toEqual("public");
  });

  test("prod server fails", async () => {
    const result = checkApiKeyIsDevServer("tr_prod_12345");
    expect(result.success).toEqual(false);
    if (result.success) return;
    expect(result.type?.environment).toEqual("prod");
    expect(result.type?.type).toEqual("server");
  });

  test("prod public fails", async () => {
    const result = checkApiKeyIsDevServer("pk_prod_12345");
    expect(result.success).toEqual(false);
    if (result.success) return;
    expect(result.type?.environment).toEqual("prod");
    expect(result.type?.type).toEqual("public");
  });
});
