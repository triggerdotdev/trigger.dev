/**
 * Simulated module 0 - mimics Sentry debug ID injection.
 *
 * Sentry's `sentry-cli sourcemaps inject` command adds code like this
 * to every bundled file to map debug IDs to sourcemaps.
 *
 * This accesses Error.stack during module loading, which before the fix
 * would trigger sourcemap parsing and cause OOM on large projects.
 */

// This is what Sentry injects for sourcemap debug ID mapping
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _sentryDebugId = (() => {
  // Sentry accesses the stack trace to extract debug information
  const stack = new Error().stack;
  return stack;
})();

export const moduleId = "0";

export function doSomething() {
  return `Module 0 doing something`;
}

export const data = {
  id: 0,
  name: "Module 0",
  description: "A simulated module that mimics Sentry debug ID injection",
};

// Add some padding to make the module more realistic in size
const _padding = `
  Lorem ipsum dolor sit amet, consectetur adipiscing elit.
  Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
  Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
  Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.
  Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia.
`;
