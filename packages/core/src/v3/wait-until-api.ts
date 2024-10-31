// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { WaitUntilAPI } from "./waitUntil/index.js";

export const waitUntil = WaitUntilAPI.getInstance();
