import { Options } from "tsup";

export const deepMergeOptions = deepMergeRecords<Options>;

function deepMergeRecords<TRecord extends Record<any, any>>(...options: TRecord[]): TRecord {
  const result = {} as TRecord;

  for (const option of options) {
    for (const key in option) {
      if (option.hasOwnProperty(key)) {
        const optionValue = option[key];
        const existingValue = result[key];

        if (
          existingValue &&
          typeof existingValue === "object" &&
          typeof optionValue === "object" &&
          !Array.isArray(existingValue) &&
          !Array.isArray(optionValue) &&
          existingValue !== null &&
          optionValue !== null
        ) {
          result[key] = deepMergeRecords(existingValue, optionValue);
        } else {
          result[key] = optionValue;
        }
      }
    }
  }

  return result;
}
