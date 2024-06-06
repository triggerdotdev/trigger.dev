import { Metafile } from "esbuild";

import { ReadConfigResult } from "../src/utilities/configFiles";

declare global {
  var resolvedConfig: ReadConfigResult | undefined;
  var tempDir: string | undefined;
  var metaOutput: Metafile["outputs"]["out/stdin.js"] | undefined;
  var entryPointMetaOutput: Metafile["outputs"]["out/stdin.js"] | undefined;
}
