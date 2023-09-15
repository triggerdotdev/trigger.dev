import mock from "mock-fs";
import { detectPagesOrAppDir, detectUseOfSrcDir } from ".";
// import { detectUseOfSrcDir } from ".";

afterEach(() => {
  mock.restore();
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
