/**
 * Simulated module 3 - mimics Sentry debug ID injection.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _sentryDebugId = (() => {
  const stack = new Error().stack;
  return stack;
})();

export const moduleId = "3";

export function doSomething() {
  return `Module 3 doing something`;
}

export const data = {
  id: 3,
  name: "Module 3",
  description: "A simulated module that mimics Sentry debug ID injection",
};

const _padding = `Lorem ipsum dolor sit amet, consectetur adipiscing elit.`;
