import {
  makeBooleanSchema,
  makeNullable,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { TimeZoneSchema } from "./timezone";

function formulaType(type: string) {
  return makeStringSchema("Type", "The type of the formula", {
    const: type,
  });
}

// type StringFormulaPropertyResponse = { type: "string"; string: string | null }
export const StringFormulaPropertyResponse = makeObjectSchema(
  "StringFormulaPropertyResponse",
  {
    requiredProperties: {
      type: formulaType("string"),
      string: makeNullable(
        makeStringSchema("String", "The string value of the property")
      ),
    },
  }
);

// type DateResponse = {
//   start: string
//   end: string | null
//   time_zone: TimeZoneRequest | null
// }
export const DateResponse = makeObjectSchema("DateResponse", {
  requiredProperties: {
    start: makeStringSchema("Start", "The start date of the date"),
    end: makeNullable(makeStringSchema("End", "The end date of the date")),
    time_zone: makeNullable(TimeZoneSchema),
  },
});

// type DateFormulaPropertyResponse = { type: "date"; date: DateResponse | null }
export const DateFormulaPropertyResponse = makeObjectSchema(
  "DateFormulaPropertyResponse",
  {
    requiredProperties: {
      type: formulaType("date"),
      date: makeNullable(DateResponse),
    },
  }
);

// type NumberFormulaPropertyResponse = { type: "number"; number: number | null }
export const NumberFormulaPropertyResponse = makeObjectSchema(
  "NumberFormulaPropertyResponse",
  {
    requiredProperties: {
      type: formulaType("number"),
      number: makeNullable(
        makeNumberSchema("Number", "The number value of the property")
      ),
    },
  }
);

// type BooleanFormulaPropertyResponse = {
//   type: "boolean"
//   boolean: boolean | null
// }
export const BooleanFormulaPropertyResponse = makeObjectSchema(
  "BooleanFormulaPropertyResponse",
  {
    requiredProperties: {
      type: formulaType("boolean"),
      boolean: makeNullable(
        makeBooleanSchema("Boolean", "The boolean value of the property")
      ),
    },
  }
);

// type FormulaPropertyResponse =
//   | StringFormulaPropertyResponse
//   | DateFormulaPropertyResponse
//   | NumberFormulaPropertyResponse
//   | BooleanFormulaPropertyResponse
export const FormulaPropertyResponse = makeOneOf("FormulaPropertyResponse", [
  StringFormulaPropertyResponse,
  DateFormulaPropertyResponse,
  NumberFormulaPropertyResponse,
  BooleanFormulaPropertyResponse,
]);
