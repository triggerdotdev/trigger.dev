import { JSONSchema } from "core/schemas/types";
import { EmptyObjectSchema } from "./primitives";

export const ExistencePropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        is_empty: {
          type: "boolean",
          const: true,
        },
      },
      required: ["is_empty"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        is_not_empty: {
          type: "boolean",
          const: true,
        },
      },
      required: ["is_not_empty"],
      additionalProperties: false,
    },
  ],
};

export const TextPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        equals: {
          type: "string",
        },
      },
      required: ["equals"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        does_not_equal: {
          type: "string",
        },
      },
      required: ["does_not_equal"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        contains: {
          type: "string",
        },
      },
      required: ["contains"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        does_not_contain: {
          type: "string",
        },
      },
      required: ["does_not_contain"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        starts_with: {
          type: "string",
        },
      },
      required: ["starts_with"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ends_with: {
          type: "string",
        },
      },
      required: ["ends_with"],
      additionalProperties: false,
    },
    ExistencePropertyFilterSchema,
  ],
};

export const NumberPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        equals: {
          type: "number",
        },
      },
      required: ["equals"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        does_not_equal: {
          type: "number",
        },
      },
      required: ["does_not_equal"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        greater_than: {
          type: "number",
        },
      },
      required: ["greater_than"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        less_than: {
          type: "number",
        },
      },
      required: ["less_than"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        greater_than_or_equal_to: {
          type: "number",
        },
      },
      required: ["greater_than_or_equal_to"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        less_than_or_equal_to: {
          type: "number",
        },
      },
      required: ["less_than_or_equal_to"],
      additionalProperties: false,
    },
    ExistencePropertyFilterSchema,
  ],
};

export const CheckboxPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        equals: {
          type: "boolean",
        },
      },
      required: ["equals"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        does_not_equal: {
          type: "boolean",
        },
      },
      required: ["does_not_equal"],
      additionalProperties: false,
    },
  ],
};

export const SelectPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        equals: {
          type: "string",
        },
      },
      required: ["equals"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        does_not_equal: {
          type: "string",
        },
      },
      required: ["does_not_equal"],
      additionalProperties: false,
    },
    ExistencePropertyFilterSchema,
  ],
};

export const MultiSelectPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        contains: {
          type: "string",
        },
      },
      required: ["contains"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        does_not_contain: {
          type: "string",
        },
      },
      required: ["does_not_contain"],
      additionalProperties: false,
    },
    ExistencePropertyFilterSchema,
  ],
};

export const StatusPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        equals: {
          type: "string",
        },
      },
      required: ["equals"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        does_not_equal: {
          type: "string",
        },
      },
      required: ["does_not_equal"],
      additionalProperties: false,
    },
    ExistencePropertyFilterSchema,
  ],
};

export const DatePropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        equals: {
          type: "string",
        },
      },
      required: ["equals"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        before: {
          type: "string",
        },
      },
      required: ["before"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        after: {
          type: "string",
        },
      },
      required: ["after"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        on_or_before: {
          type: "string",
        },
      },
      required: ["on_or_before"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        on_or_after: {
          type: "string",
        },
      },
      required: ["on_or_after"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        this_week: EmptyObjectSchema,
      },
      required: ["this_week"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        past_week: EmptyObjectSchema,
      },
      required: ["past_week"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        past_month: EmptyObjectSchema,
      },
      required: ["past_month"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        past_year: EmptyObjectSchema,
      },
      required: ["past_year"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        next_week: EmptyObjectSchema,
      },
      required: ["next_week"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        next_month: EmptyObjectSchema,
      },
      required: ["next_month"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        next_year: EmptyObjectSchema,
      },
      required: ["next_year"],
      additionalProperties: false,
    },
    ExistencePropertyFilterSchema,
  ],
};

export const PeoplePropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        contains: IdRequestSchema,
      },
      required: ["contains"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        does_not_contain: IdRequestSchema,
      },
      required: ["does_not_contain"],
      additionalProperties: false,
    },
    ExistencePropertyFilterSchema,
  ],
};

export const RelationPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        contains: IdRequestSchema,
      },
      required: ["contains"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        does_not_contain: IdRequestSchema,
      },
      required: ["does_not_contain"],
      additionalProperties: false,
    },
    ExistencePropertyFilterSchema,
  ],
};

export const FormulaPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        string: TextPropertyFilterSchema,
      },
      required: ["string"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        checkbox: CheckboxPropertyFilterSchema,
      },
      required: ["checkbox"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        number: NumberPropertyFilterSchema,
      },
      required: ["number"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        date: DatePropertyFilterSchema,
      },
      required: ["date"],
      additionalProperties: false,
    },
  ],
};

export const RollupSubfilterPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        rich_text: TextPropertyFilterSchema,
      },
      required: ["rich_text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        number: NumberPropertyFilterSchema,
      },
      required: ["number"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        checkbox: CheckboxPropertyFilterSchema,
      },
      required: ["checkbox"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        select: SelectPropertyFilterSchema,
      },
      required: ["select"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        multi_select: MultiSelectPropertyFilterSchema,
      },
      required: ["multi_select"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        relation: RelationPropertyFilterSchema,
      },
      required: ["relation"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        date: DatePropertyFilterSchema,
      },
      required: ["date"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        people: PeoplePropertyFilterSchema,
      },
      required: ["people"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        files: ExistencePropertyFilterSchema,
      },
      required: ["files"],
      additionalProperties: false,
    },
  ],
};

export const RollupPropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        any: RollupSubfilterPropertyFilterSchema,
      },
      required: ["any"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        none: RollupSubfilterPropertyFilterSchema,
      },
      required: ["none"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        every: RollupSubfilterPropertyFilterSchema,
      },
      required: ["every"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        date: DatePropertyFilterSchema,
      },
      required: ["date"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        number: NumberPropertyFilterSchema,
      },
      required: ["number"],
      additionalProperties: false,
    },
  ],
};

export const PropertyFilterSchema: JSONSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        title: TextPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "title",
        },
      },
      required: ["title", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        rich_text: TextPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "rich_text",
        },
      },
      required: ["rich_text", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        number: NumberPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "number",
        },
      },
      required: ["number", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        checkbox: CheckboxPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "checkbox",
        },
      },
      required: ["checkbox", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        select: SelectPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "select",
        },
      },
      required: ["select", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        multi_select: MultiSelectPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "multi_select",
        },
      },
      required: ["multi_select", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        status: StatusPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "status",
        },
      },
      required: ["status", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        date: DatePropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "date",
        },
      },
      required: ["date", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        people: PeoplePropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "people",
        },
      },
      required: ["people", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        files: ExistencePropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "files",
        },
      },
      required: ["files", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        url: TextPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "url",
        },
      },
      required: ["url", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        email: TextPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "email",
        },
      },
      required: ["email", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        phone_number: TextPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "phone_number",
        },
      },
      required: ["phone_number", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        relation: RelationPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "relation",
        },
      },
      required: ["relation", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        created_by: PeoplePropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "created_by",
        },
      },
      required: ["created_by", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        created_time: DatePropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "created_time",
        },
      },
      required: ["created_time", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        last_edited_by: PeoplePropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "last_edited_by",
        },
      },
      required: ["last_edited_by", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        last_edited_time: DatePropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "last_edited_time",
        },
      },
      required: ["last_edited_time", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        formula: FormulaPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "formula",
        },
      },
      required: ["formula", "property"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        rollup: RollupPropertyFilterSchema,
        property: {
          type: "string",
        },
        type: {
          type: "string",
          const: "rollup",
        },
      },
      required: ["rollup", "property"],
      additionalProperties: false,
    },
  ],
};

export const TimestampCreatedTimeFilterSchema: JSONSchema = {
  type: "object",
  properties: {
    created_time: DatePropertyFilterSchema,
    timestamp: {
      type: "string",
      const: "created_time",
    },
    type: {
      type: "string",
      const: "created_time",
    },
  },
  required: ["created_time", "timestamp"],
  additionalProperties: false,
};

export const TimestampLastEditedTimeFilterSchema: JSONSchema = {
  type: "object",
  properties: {
    last_edited_time: DatePropertyFilterSchema,
    timestamp: {
      type: "string",
      const: "last_edited_time",
    },
    type: {
      type: "string",
      const: "last_edited_time",
    },
  },
  required: ["last_edited_time", "timestamp"],
  additionalProperties: false,
};
