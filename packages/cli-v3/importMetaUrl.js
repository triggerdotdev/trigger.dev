// as per https://github.com/evanw/esbuild/issues/1492
// to make some libs work
export const import_meta_url = require("url").pathToFileURL(__filename);
