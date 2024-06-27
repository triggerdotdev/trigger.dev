import { createHash } from "node:crypto";
import { OutputFile } from "esbuild";

type CreateDeployHashOptions = {
  dependencies: { [k: string]: string };
  entryPointOutputFile: OutputFile;
  workerOutputFile: OutputFile;
};

export async function createDeployHash(options: CreateDeployHashOptions) {
  const { dependencies, entryPointOutputFile, workerOutputFile } = options;

  // COPIED FROM compileProject()
  const contentHasher = createHash("sha256");
  contentHasher.update(Buffer.from(entryPointOutputFile.text));
  contentHasher.update(Buffer.from(workerOutputFile.text));
  contentHasher.update(Buffer.from(JSON.stringify(dependencies)));

  const contentHash = contentHasher.digest("hex");

  // span.setAttributes({
  //   contentHash: contentHash,
  // });

  // span.end();

  return { contentHash };
}
