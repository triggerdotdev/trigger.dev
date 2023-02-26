import { JSONSchema } from "core/schemas/types";

export const RollupFunction: JSONSchema = {
  "type": "string",
  "enum": [
    "count",
    "count_values",
    "empty",
    "not_empty",
    "unique",
    "show_unique",
    "percent_empty",
    "percent_not_empty",
    "sum",
    "average",
    "median",
    "min",
    "max",
    "range",
    "earliest_date",
    "latest_date",
    "date_range",
    "checked",
    "unchecked",
    "percent_checked",
    "percent_unchecked",
    "count_per_group",
    "percent_per_group",
    "show_original"
  ]
};
