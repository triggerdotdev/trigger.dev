import { DeserializedJson, DeserializedJsonSchema } from "./schemas";

export interface ExampleReplacement {
  marker: string;
  replace(input: ExampleInputData): DeserializedJson;
}

type ExampleInputData = {
  match: {
    key: string;
    value: string;
  };
  now: Date;
};

export const currentDate: ExampleReplacement = {
  marker: "__CURRENT_DATE__",
  replace({ now }: ExampleInputData) {
    return now.toISOString();
  },
};

export const replacements: ExampleReplacement[] = [currentDate];

DeserializedJsonSchema;
