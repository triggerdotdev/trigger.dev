import mock from "mock-fs";
import fs from "fs/promises";

export function readFileIgnoringMock(filePath: string): Promise<string> {
  return mock.bypass(async () => {
    return await fs.readFile(filePath, { encoding: "utf-8" });
  });
}
