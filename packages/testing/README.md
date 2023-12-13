# Trigger.dev Testing Package

The testing package provides useful helpers to write your own tests in jest and vitest with complete type support.

## Usage

1. Install the package:

```bash
# npm
npm install -D @trigger.dev/testing

# yarn
yarn add -D @trigger.dev/testing

# pnpm
pnpm add -D @trigger.dev/testing
```

2. Import the package in a test as follows:

```js
import { toHaveSucceeded, createJobTester } from "@trigger.dev/testing";
import { expect, vi } from "vitest";

expect.extend({ toHaveSucceeded });
const testJob = createJobTester(vi);
```

3. You can then use it like this:

```js
const jobToTest = client.defineJob({
  id: "test-job",
  name: "Test Job",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "test.trigger",
  }),
  integrations: {
    dummy,
  },
  run: async (payload, io, ctx) => {
    return await io.dummy.doSomething("test-task", {
      foo: payload.foo,
    });
  },
});

const testRun = await testJob(jobToTest, {
  payload: {
    foo: "bar",
  },
  tasks: {
    "test-task": {
      bar: "baz",
    },
  },
});

// job run was successful
expect(testRun).toHaveSucceeded();

// task was called exactly once
expect(testRun.tasks["test-task"]).toHaveBeenCalledOnce();

// task was called with correct params
expect(testRun.tasks["test-task"]).toHaveBeenCalledWith({ foo: "bar" });

// mocked task output was correctly returned
expect(testRun.tasks["test-task"]).toHaveReturnedWith({ bar: "baz" });

// job run has expected output
expect(testRun.output).toEqual({ bar: "baz" });
```

## More information

See the official [Trigger.dev Unit Testing Reference](https://github.com/triggerdotdev/trigger.dev/tree/main/references/unit-testing/) for a working setup with Vitest.

## License

MIT
