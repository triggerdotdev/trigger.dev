import { task } from "@trigger.dev/sdk/v3";

export const returnAllTypes = task({
  id: "return-all-types",
  run: async () => {
    const resultString = await returnString.triggerAndWait();
    const resultNumber = await returnNumber.triggerAndWait();
    const resultTrue = await returnTrue.triggerAndWait();
    const resultFalse = await returnFalse.triggerAndWait();
    const resultNull = await returnNull.triggerAndWait();
    const resultUndefined = await returnUndefined.triggerAndWait();
    const resultObject = await returnObject.triggerAndWait();
    const resultArray = await returnArray.triggerAndWait();

    return {
      resultString,
      resultNumber,
      resultTrue,
      resultFalse,
      resultNull,
      resultUndefined,
      resultObject,
      resultArray,
    };
  },
});

export const returnString = task({
  id: "return-string",
  run: async () => {
    return "This is a string";
  },
});

export const returnNumber = task({
  id: "return-number",
  run: async () => {
    return 42;
  },
});

export const returnTrue = task({
  id: "return-true",
  run: async () => {
    return true;
  },
});

export const returnFalse = task({
  id: "return-false",
  run: async () => {
    return false;
  },
});

export const returnNull = task({
  id: "return-null",
  run: async () => {
    return null;
  },
});

export const returnUndefined = task({
  id: "return-undefined",
  run: async () => {
    return undefined;
  },
});

export const returnObject = task({
  id: "return-object",
  run: async () => {
    return { key: "value" };
  },
});

export const returnArray = task({
  id: "return-array",
  run: async () => {
    return [1, 2, 3];
  },
});
