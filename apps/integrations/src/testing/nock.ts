import nock from "nock";
import { Suite, File } from "vitest";
import fs from "fs/promises";
import path from "path";

export function setupNock(fileName: string) {
  const nockFile = getFileName(fileName);
  nock.cleanAll();
  try {
    nock.load(nockFile);
  } catch (e) {
    nock.recorder.clear();
    nock.recorder.rec({ output_objects: true, dont_print: true });
  }
}

export async function saveToNock(fileName: string, suite: Suite | File) {
  const nockFile = getFileName(fileName);
  const succeeded = suite.tasks?.every((t) => t.result?.state !== "fail");

  const nockCalls = nock.recorder.play();
  nock.recorder.clear();

  if (!succeeded) {
    console.log("Removing nock file", nockFile);
    await fs.rm(nockFile, { force: true });
    return;
  }

  if (nockCalls.length > 0) {
    await fs.mkdir(path.dirname(nockFile), { recursive: true });
    await fs.writeFile(nockFile, JSON.stringify(nockCalls, null, 2), {
      encoding: "utf-8",
    });
    console.log("Saved successful test result to nock", nockFile);
  }
}

function getFileName(fileName: string) {
  return `${fileName}.nock.json`;
}
//
