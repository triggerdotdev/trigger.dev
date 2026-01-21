/**
 * Index file that imports all simulated modules with Sentry debug ID injection.
 *
 * This simulates what happens when a project uses Sentry and runs:
 * `sentry-cli sourcemaps inject`
 *
 * Each imported module contains `new Error().stack` which, before the fix,
 * would trigger sourcemap parsing during module loading and cause OOM.
 *
 * Note: In the real issue, there would be ~2000+ modules. This reference
 * project uses 10 modules to demonstrate the pattern without generating
 * too many files. The fix works regardless of module count.
 */

import * as module0 from "./simulated0.js";
import * as module1 from "./simulated1.js";
import * as module2 from "./simulated2.js";
import * as module3 from "./simulated3.js";
import * as module4 from "./simulated4.js";
import * as module5 from "./simulated5.js";
import * as module6 from "./simulated6.js";
import * as module7 from "./simulated7.js";
import * as module8 from "./simulated8.js";
import * as module9 from "./simulated9.js";

export const allModules = {
  module0,
  module1,
  module2,
  module3,
  module4,
  module5,
  module6,
  module7,
  module8,
  module9,
};

export const allModulesCount = 10;
