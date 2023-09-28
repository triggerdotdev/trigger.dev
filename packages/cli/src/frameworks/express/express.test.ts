import mock from "mock-fs";
import { Express } from ".";
import { getFramework } from "..";
import { pathExists } from "../../utils/fileSystem";

afterEach(() => {
  mock.restore();
});

describe("Express project detection", () => {
  test("has dependency", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { express: "1.0.0" } }),
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).toEqual("express");
  });

  test("no dependency", async () => {
    mock({
      "package.json": JSON.stringify({ dependencies: { foo: "1.0.0" } }),
    });

    const framework = await getFramework("", "npm");
    expect(framework?.id).not.toEqual("express");
  });
});
