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

// describe("install", () => {
//   test("src/pages + javascript", async () => {
//     mock({
//       "src/pages": {},
//     });

//     const projectType = await detectPagesOrAppDir("");
//     expect(projectType).toEqual("pages");

//     const nextJs = new NextJs();
//     await nextJs.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
//     expect(await pathExists("src/trigger.js")).toEqual(true);
//     expect(await pathExists("src/pages/api/trigger.js")).toEqual(true);
//     expect(await pathExists("src/jobs/index.js")).toEqual(true);
//     expect(await pathExists("src/jobs/examples.js")).toEqual(true);
//   });

//   test("pages + javascript", async () => {
//     mock({
//       pages: {},
//     });

//     const projectType = await detectPagesOrAppDir("");
//     expect(projectType).toEqual("pages");

//     const nextJs = new NextJs();
//     await nextJs.install("", { typescript: false, packageManager: "npm", endpointSlug: "foo" });
//     expect(await pathExists("trigger.js")).toEqual(true);
//     expect(await pathExists("pages/api/trigger.js")).toEqual(true);
//     expect(await pathExists("jobs/index.js")).toEqual(true);
//     expect(await pathExists("jobs/examples.js")).toEqual(true);
//   });

//   test("src/pages + typescript", async () => {
//     mock({
//       "src/pages": {},
//       "tsconfig.json": JSON.stringify({}),
//     });

//     const projectType = await detectPagesOrAppDir("");
//     expect(projectType).toEqual("pages");

//     const nextJs = new NextJs();
//     await nextJs.install("", { typescript: true, packageManager: "npm", endpointSlug: "foo" });
//     expect(await pathExists("src/trigger.ts")).toEqual(true);
//     expect(await pathExists("src/pages/api/trigger.ts")).toEqual(true);
//     expect(await pathExists("src/jobs/index.ts")).toEqual(true);
//     expect(await pathExists("src/jobs/examples.ts")).toEqual(true);
//   });

//   test("pages + typescript", async () => {
//     mock({
//       pages: {},
//       "tsconfig.json": JSON.stringify({}),
//     });

//     const projectType = await detectPagesOrAppDir("");
//     expect(projectType).toEqual("pages");

//     const nextJs = new NextJs();
//     await nextJs.install("", { typescript: true, packageManager: "npm", endpointSlug: "foo" });
//     expect(await pathExists("trigger.ts")).toEqual(true);
//     expect(await pathExists("pages/api/trigger.ts")).toEqual(true);
//     expect(await pathExists("jobs/index.ts")).toEqual(true);
//     expect(await pathExists("jobs/examples.ts")).toEqual(true);
//   });
// });
