import { Metafile, OutputFile } from "esbuild";

import { ReadConfigResult } from "../src/utilities/configFiles";

declare global {
  var dependencies: { [k: string]: string } | undefined;
  var entryPointMetaOutput: Metafile["outputs"]["out/stdin.js"] | undefined;
  var entryPointOutputFile: OutputFile | undefined;
  var resolvedConfig: ReadConfigResult | undefined;
  var tempDir: string | undefined;
  var workerMetaOutput: Metafile["outputs"]["out/stdin.js"] | undefined;
  var workerOutputFile: OutputFile | undefined;
}
