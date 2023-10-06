import mock from "mock-fs";
import { Astro } from ".";
import { getFramework } from "..";
import { pathExists } from "../../utils/fileSystem";

afterEach(() => {
  mock.restore();
});

describe("Astro project detection", () => {
  test("has dependency", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { astro: "1.0.0" } }),
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).toEqual("astro");
  });

  test("no dependency, has astro.config.js", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { foo: "1.0.0" } }),
      "astro.config.js": "module.exports = {}",
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).toEqual("astro");
  });

  test("no dependency, has astro.config.mjs", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { foo: "1.0.0" } }),
      "astro.config.mjs": "module.exports = {}",
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).toEqual("astro");
  });

  test("no dependency, no astro.config.*", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { foo: "1.0.0" } }),
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).not.toEqual("astro");
  });
});

describe("install", () => {
  test("javascript", async () => {
    mock({
      src: {
        pages: {},
      },
    });

    const astro = new Astro();
    await astro.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("src/trigger.js")).toEqual(true);
    expect(await pathExists("src/pages/api/trigger.js")).toEqual(true);
    expect(await pathExists("src/jobs/example.js")).toEqual(true);
    expect(await pathExists("src/jobs/index.js")).toEqual(true);
  });

  test("typescript", async () => {
    mock({
      app: {
        routes: {},
      },
      "tsconfig.json": JSON.stringify({}),
    });

    const astro = new Astro();
    await astro.install("", { typescript: true, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("src/trigger.ts")).toEqual(true);
    expect(await pathExists("src/pages/api/trigger.ts")).toEqual(true);
    expect(await pathExists("src/jobs/example.ts")).toEqual(true);
    expect(await pathExists("src/jobs/index.ts")).toEqual(true);
  });
});
