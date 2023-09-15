import mock from "mock-fs";
import { NextJs, detectPagesOrAppDir, detectUseOfSrcDir } from ".";
import { getFramework } from "..";

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

  test("no dependency", async () => {
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

describe("file creation", () => {
  test("pages + javascript (without jsconfig)", async () => {
    mock({
      "src/app": {},
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("app");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
  });

  test("pages + javascript (with blank jsconfig)", async () => {
    mock({
      "src/app": {},
      "jsconfig.json": "{}",
    });

    const projectType = await detectPagesOrAppDir("");
    expect(projectType).toEqual("app");

    const nextJs = new NextJs();
    await nextJs.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
  });
});
