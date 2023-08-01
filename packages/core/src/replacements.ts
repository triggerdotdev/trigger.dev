import { DeserializedJson } from "./schemas";

export interface ExampleReplacement {
  marker: string;
  replace(input: ExampleInputData): DeserializedJson;
}

type ExampleInputData = {
  match: {
    key: string;
    value: string;
  };
  data: {
    now: Date;
  };
};

export const currentDate: ExampleReplacement = {
  marker: "__CURRENT_DATE__",
  replace({ data: { now } }: ExampleInputData) {
    return now.toISOString();
  },
};

export const currentTimestampMilliseconds: ExampleReplacement = {
  marker: "__CURRENT_TIMESTAMP_MS__",
  replace({ data: { now } }: ExampleInputData) {
    return now.getTime();
  },
};

export const currentTimestampSeconds: ExampleReplacement = {
  marker: "__CURRENT_TIMESTAMP_S__",
  replace({ data: { now } }: ExampleInputData) {
    return now.getTime() / 1000;
  },
};

export const replacements: ExampleReplacement[] = [
  currentDate,
  currentTimestampMilliseconds,
  currentTimestampSeconds,
];
