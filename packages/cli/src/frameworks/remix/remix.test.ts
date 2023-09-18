import mock from "mock-fs";
import { Remix } from ".";
import { getFramework } from "..";
import { pathExists } from "../../utils/fileSystem";

afterEach(() => {
  mock.restore();
});

describe("Remix project detection", () => {
  test("has dependency", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { "@remix-run/express": "1.0.0" } }),
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).toEqual("remix");
  });

  test("no dependency, has remix.config.js", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { foo: "1.0.0" } }),
      "remix.config.js": "module.exports = {}",
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).toEqual("remix");
  });

  test("no dependency, no remix.config.js", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { foo: "1.0.0" } }),
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).not.toEqual("remix");
  });
});

describe("install", () => {
  test("javascript", async () => {
    mock({
      app: {
        routes: {},
      },
    });

    const remix = new Remix();
    await remix.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("app/trigger.server.js")).toEqual(true);
    expect(await pathExists("app/routes/api.trigger.js")).toEqual(true);
    expect(await pathExists("app/jobs/example.server.js")).toEqual(true);
  });

  test("typescript", async () => {
    mock({
      app: {
        routes: {},
      },
      "tsconfig.json": JSON.stringify({}),
    });

    const remix = new Remix();
    await remix.install("", { typescript: true, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("app/trigger.server.ts")).toEqual(true);
    expect(await pathExists("app/routes/api.trigger.ts")).toEqual(true);
    expect(await pathExists("app/jobs/example.server.ts")).toEqual(true);
  });
});
