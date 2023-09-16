import fs from "fs/promises";
import mock from "mock-fs";
import { createFileFromTemplate, replaceAll } from "./createFileFromTemplate";

afterEach(() => {
  mock.restore();
});

const preReplacement = `import { createPagesRoute } from "@trigger.dev/nextjs";
import { client } from "\${routePathPrefix}trigger";
import { other } from "\${routePathPrefix}trigger";
import "\${anotherPathPrefix}jobs";

const { handler, config } = createPagesRoute(client);`;

const postReplacement = `import { createPagesRoute } from "@trigger.dev/nextjs";
import { client } from "@/trigger";
import { other } from "@/trigger";
import "@/src/jobs";

const { handler, config } = createPagesRoute(client);`;

describe("Replace function", () => {
  test("simple replacements", async () => {
    const output = replaceAll(preReplacement, {
      routePathPrefix: "@/",
      anotherPathPrefix: "@/src/",
    });
    expect(output).toEqual(postReplacement);
  });
});

describe("Template files", () => {
  test("basic template", async () => {
    mock({
      templates: {
        "some-file.js": preReplacement,
      },
    });

    const template = await fs.readFile("templates/some-file.js", "utf-8");
    const result = await createFileFromTemplate({
      template,
      replacements: {
        routePathPrefix: "@/",
        anotherPathPrefix: "@/src/",
      },
      outputPath: "foo/output.ts",
    });

    expect(result.success).toEqual(true);
    if (!result.success) return;
    expect(result.alreadyExisted).toEqual(false);

    const fileContents = await fs.readFile("foo/output.ts", "utf-8");
    expect(fileContents).toEqual(postReplacement);
  });
});
