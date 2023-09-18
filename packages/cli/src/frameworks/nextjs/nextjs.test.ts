import mock from "mock-fs";
import { NextJs, detectPagesOrAppDir, detectUseOfSrcDir } from ".";
import { getFramework } from "..";
import { pathExists } from "../../utils/fileSystem";

afterEach(() => {
  mock.restore();
});

describe("Next project detection", () => {
  test("has dependency", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { next: "1.0.0" } }),
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).toEqual("nextjs");
  });

  test("no dependency, has next.config.js", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { foo: "1.0.0" } }),
      "next.config.js": "module.exports = {}",
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).toEqual("nextjs");
  });

  test("no dependency, no next.config.js", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { foo: "1.0.0" } }),
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).not.toEqual("nextjs");
  });
});

describe("src directory", () => {
  test("has src directory", async () => {
    mock({
      src: {
        "some-file.txt": "file content here",
      },
    });

    const hasSrcDirectory = await detectUseOfSrcDir("");
    expect(hasSrcDirectory).toEqual(true);
  });

  test("no src directory", async () => {
    mock({
      app: {
        "some-file.txt": "file content here",
      },
    });

    const hasSrcDirectory = await detectUseOfSrcDir("");
    expect(hasSrcDirectory).toEqual(false);
  });
});

describe("detect pages or app directory", () => {
  test("detect 'app' from src/app directory", async () => {
    mock({
      "src/app": {},
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("app");
  });

  test("detect 'app' from src/app directory", async () => {
    mock({
      "src/app": {},
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("app");
  });

  test("detect 'pages' from src/pages directory", async () => {
    mock({
      "src/pages": {
        "some-file.txt": "file content here",
      },
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("pages");
  });

  test("detect 'pages' from pages directory", async () => {
    mock({
      pages: {
        "some-file.txt": "file content here",
      },
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("pages");
  });
});

describe("pages install", () => {
  test("src/pages + javascript", async () => {
    mock({
      "src/pages": {},
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("pages");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("src/trigger.js")).toEqual(true);
    expect(await pathExists("src/pages/api/trigger.js")).toEqual(true);
    expect(await pathExists("src/jobs/index.js")).toEqual(true);
    expect(await pathExists("src/jobs/examples.js")).toEqual(true);
  });

  test("pages + javascript", async () => {
    mock({
      pages: {},
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("pages");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("trigger.js")).toEqual(true);
    expect(await pathExists("pages/api/trigger.js")).toEqual(true);
    expect(await pathExists("jobs/index.js")).toEqual(true);
    expect(await pathExists("jobs/examples.js")).toEqual(true);
  });

  test("src/pages + typescript", async () => {
    mock({
      "src/pages": {},
      "tsconfig.json": JSON.stringify({}),
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("pages");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: true, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("src/trigger.ts")).toEqual(true);
    expect(await pathExists("src/pages/api/trigger.ts")).toEqual(true);
    expect(await pathExists("src/jobs/index.ts")).toEqual(true);
    expect(await pathExists("src/jobs/examples.ts")).toEqual(true);
  });

  test("pages + typescript", async () => {
    mock({
      pages: {},
      "tsconfig.json": JSON.stringify({}),
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("pages");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: true, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("trigger.ts")).toEqual(true);
    expect(await pathExists("pages/api/trigger.ts")).toEqual(true);
    expect(await pathExists("jobs/index.ts")).toEqual(true);
    expect(await pathExists("jobs/examples.ts")).toEqual(true);
  });
});

describe("app install", () => {
  test("src/app + javascript", async () => {
    mock({
      "src/app": {},
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("app");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("src/trigger.js")).toEqual(true);
    expect(await pathExists("src/app/api/trigger/route.js")).toEqual(true);
    expect(await pathExists("src/jobs/index.js")).toEqual(true);
    expect(await pathExists("src/jobs/examples.js")).toEqual(true);
  });

  test("app + javascript", async () => {
    mock({
      app: {},
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("app");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("trigger.js")).toEqual(true);
    expect(await pathExists("app/api/trigger/route.js")).toEqual(true);
    expect(await pathExists("jobs/index.js")).toEqual(true);
    expect(await pathExists("jobs/examples.js")).toEqual(true);
  });

  test("src/app + typescript", async () => {
    mock({
      "src/app": {},
      "tsconfig.json": JSON.stringify({}),
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("app");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: true, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("src/trigger.ts")).toEqual(true);
    expect(await pathExists("src/app/api/trigger/route.ts")).toEqual(true);
    expect(await pathExists("src/jobs/index.ts")).toEqual(true);
    expect(await pathExists("src/jobs/examples.ts")).toEqual(true);
  });

  test("app + typescript", async () => {
    mock({
      app: {},
      "tsconfig.json": JSON.stringify({}),
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("app");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: true, packageManager: "npm", endpointSlug: "foo" });
    expect(await pathExists("trigger.ts")).toEqual(true);
    expect(await pathExists("app/api/trigger/route.ts")).toEqual(true);
    expect(await pathExists("jobs/index.ts")).toEqual(true);
    expect(await pathExists("jobs/examples.ts")).toEqual(true);
  });
});
