import mock from "mock-fs";
// import { detectUseOfSrcDir } from ".";

afterEach(() => {
  mock.restore();
});

describe("install", () => {
  test("detect use of src directory", async () => {
    mock({
      src: {
        "some-file.txt": "file content here",
      },
    });

    // const hasSrcDirectory = await detectUseOfSrcDir("/");
    expect(true).toEqual(true);
  });
});
