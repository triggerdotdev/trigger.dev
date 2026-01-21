/**
 * Simulated module 2 - mimics Sentry debug ID injection.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _sentryDebugId = (() => {
  const stack = new Error().stack;
  return stack;
})();

export const moduleId = "2";

export function doSomething() {
  return `Module 2 doing something`;
}

export const data = {
  id: 2,
  name: "Module 2",
  description: "A simulated module that mimics Sentry debug ID injection",
};

const _padding = `Lorem ipsum dolor sit amet, consectetur adipiscing elit.`;
