// Minimal `process` stand-in injected into prebundled browser deps
// (see vite.config.ts optimizeDeps). Client-only.
export const process = {
  env: {},
  browser: true,
  version: "",
  platform: "browser",
  cwd: () => "/",
  nextTick: (fn, ...args) => setTimeout(() => fn(...args), 0),
};
