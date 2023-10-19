import mock from "mock-fs";
import { getPathAlias } from "./pathAlias";

describe("javascript config", () => {
  test("no jsconfig means no alias", async () => {
    mock({
      "src/pages": {},
    });

    const alias = await getPathAlias({
      projectPath: "",
      isTypescriptProject: false,
      extraDirectories: ["src"],
    });

    expect(alias).toBeUndefined();
  });

  test("jsconfig without alias", async () => {
    mock({
      "src/pages": {},
      "jsconfig.json": JSON.stringify({}),
    });

    const alias = await getPathAlias({
      projectPath: "",
      isTypescriptProject: false,
      extraDirectories: ["src"],
    });

    expect(alias).toBeUndefined();
  });

  test("jsconfig without paths", async () => {
    mock({
      "src/pages": {},
      "jsconfig.json": `{"compilerOptions": {}}`,
    });

    const alias = await getPathAlias({
      projectPath: "",
      isTypescriptProject: false,
      extraDirectories: ["src"],
    });

    expect(alias).toBeUndefined();
  });

  test("jsconfig without matching alias", async () => {
    mock({
      "src/pages": {},
      "jsconfig.json": `{"compilerOptions": { "paths": {
        "~/*": ["./app/*"]
      }}}`,
    });

    const alias = await getPathAlias({
      projectPath: "",
      isTypescriptProject: false,
      extraDirectories: ["src"],
    });

    expect(alias).toBeUndefined();
  });

  test("jsconfig src dir", async () => {
    mock({
      "src/pages": {},
      "jsconfig.json": `{"compilerOptions": { "paths": {
        "~/*": ["./src/*"]
      }}}`,
    });

    const alias = await getPathAlias({
      projectPath: "",
      isTypescriptProject: false,
      extraDirectories: ["src"],
    });

    expect(alias).toEqual("~");
  });

  test("jsconfig no src dir", async () => {
    mock({
      pages: {},
      "jsconfig.json": `{"compilerOptions": { "paths": {
        "~/*": ["./*"]
      }}}`,
    });

    const alias = await getPathAlias({
      projectPath: "",
      isTypescriptProject: false,
    });

    expect(alias).toEqual("~");
  });

  test("tsconfig no src dir", async () => {
    mock({
      "src/pages": {},
      "tsconfig.json": `{"compilerOptions": { "paths": {
        "~/*": ["./src/*"]
      }}}`,
    });

    const alias = await getPathAlias({
      projectPath: "",
      isTypescriptProject: true,
      extraDirectories: ["src"],
    });

    expect(alias).toEqual("~");
  });

  test("tsconfig no src dir", async () => {
    mock({
      pages: {},
      "tsconfig.json": `{"compilerOptions": { "paths": {
        "~/*": ["./*"]
      }}}`,
    });

    const alias = await getPathAlias({
      projectPath: "",
      isTypescriptProject: true,
    });

    expect(alias).toEqual("~");
  });
});
