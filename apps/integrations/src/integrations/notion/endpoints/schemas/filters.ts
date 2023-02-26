import { JSONSchema } from "core/schemas/types";

export const ExistencePropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "is_empty": {
          "type": "boolean",
          "const": true
        }
      },
      "required": [
        "is_empty"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "is_not_empty": {
          "type": "boolean",
          "const": true
        }
      },
      "required": [
        "is_not_empty"
      ],
      "additionalProperties": false
    }
  ]
};

export const TextPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "equals": {
          "type": "string"
        }
      },
      "required": [
        "equals"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "does_not_equal": {
          "type": "string"
        }
      },
      "required": [
        "does_not_equal"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "contains": {
          "type": "string"
        }
      },
      "required": [
        "contains"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "does_not_contain": {
          "type": "string"
        }
      },
      "required": [
        "does_not_contain"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "starts_with": {
          "type": "string"
        }
      },
      "required": [
        "starts_with"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "ends_with": {
          "type": "string"
        }
      },
      "required": [
        "ends_with"
      ],
      "additionalProperties": false
    },
    ExistencePropertyFilter
  ]
};

export const NumberPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "equals": {
          "type": "number"
        }
      },
      "required": [
        "equals"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "does_not_equal": {
          "type": "number"
        }
      },
      "required": [
        "does_not_equal"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "greater_than": {
          "type": "number"
        }
      },
      "required": [
        "greater_than"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "less_than": {
          "type": "number"
        }
      },
      "required": [
        "less_than"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "greater_than_or_equal_to": {
          "type": "number"
        }
      },
      "required": [
        "greater_than_or_equal_to"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "less_than_or_equal_to": {
          "type": "number"
        }
      },
      "required": [
        "less_than_or_equal_to"
      ],
      "additionalProperties": false
    },
    ExistencePropertyFilter
  ]
};

export const CheckboxPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "equals": {
          "type": "boolean"
        }
      },
      "required": [
        "equals"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "does_not_equal": {
          "type": "boolean"
        }
      },
      "required": [
        "does_not_equal"
      ],
      "additionalProperties": false
    }
  ]
};

export const SelectPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "equals": {
          "type": "string"
        }
      },
      "required": [
        "equals"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "does_not_equal": {
          "type": "string"
        }
      },
      "required": [
        "does_not_equal"
      ],
      "additionalProperties": false
    },
    ExistencePropertyFilter
  ]
};

export const MultiSelectPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "contains": {
          "type": "string"
        }
      },
      "required": [
        "contains"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "does_not_contain": {
          "type": "string"
        }
      },
      "required": [
        "does_not_contain"
      ],
      "additionalProperties": false
    },
    ExistencePropertyFilter
  ]
};

export const StatusPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "equals": {
          "type": "string"
        }
      },
      "required": [
        "equals"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "does_not_equal": {
          "type": "string"
        }
      },
      "required": [
        "does_not_equal"
      ],
      "additionalProperties": false
    },
    ExistencePropertyFilter
  ]
};

export const DatePropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "equals": {
          "type": "string"
        }
      },
      "required": [
        "equals"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "before": {
          "type": "string"
        }
      },
      "required": [
        "before"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "after": {
          "type": "string"
        }
      },
      "required": [
        "after"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "on_or_before": {
          "type": "string"
        }
      },
      "required": [
        "on_or_before"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "on_or_after": {
          "type": "string"
        }
      },
      "required": [
        "on_or_after"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "this_week": EmptyObject
      },
      "required": [
        "this_week"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "past_week": EmptyObject
      },
      "required": [
        "past_week"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "past_month": EmptyObject
      },
      "required": [
        "past_month"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "past_year": EmptyObject
      },
      "required": [
        "past_year"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "next_week": EmptyObject
      },
      "required": [
        "next_week"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "next_month": EmptyObject
      },
      "required": [
        "next_month"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "next_year": EmptyObject
      },
      "required": [
        "next_year"
      ],
      "additionalProperties": false
    },
    ExistencePropertyFilter
  ]
};

export const PeoplePropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "contains": IdRequest
      },
      "required": [
        "contains"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "does_not_contain": IdRequest
      },
      "required": [
        "does_not_contain"
      ],
      "additionalProperties": false
    },
    ExistencePropertyFilter
  ]
};

export const RelationPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "contains": IdRequest
      },
      "required": [
        "contains"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "does_not_contain": IdRequest
      },
      "required": [
        "does_not_contain"
      ],
      "additionalProperties": false
    },
    ExistencePropertyFilter
  ]
};

export const FormulaPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "string": TextPropertyFilter
      },
      "required": [
        "string"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "checkbox": CheckboxPropertyFilter
      },
      "required": [
        "checkbox"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "number": NumberPropertyFilter
      },
      "required": [
        "number"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "date": DatePropertyFilter
      },
      "required": [
        "date"
      ],
      "additionalProperties": false
    }
  ]
};

export const RollupSubfilterPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "rich_text": TextPropertyFilter
      },
      "required": [
        "rich_text"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "number": NumberPropertyFilter
      },
      "required": [
        "number"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "checkbox": CheckboxPropertyFilter
      },
      "required": [
        "checkbox"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "select": SelectPropertyFilter
      },
      "required": [
        "select"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "multi_select": MultiSelectPropertyFilter
      },
      "required": [
        "multi_select"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "relation": RelationPropertyFilter
      },
      "required": [
        "relation"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "date": DatePropertyFilter
      },
      "required": [
        "date"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "people": PeoplePropertyFilter
      },
      "required": [
        "people"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "files": ExistencePropertyFilter
      },
      "required": [
        "files"
      ],
      "additionalProperties": false
    }
  ]
};

export const RollupPropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "any": RollupSubfilterPropertyFilter
      },
      "required": [
        "any"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "none": RollupSubfilterPropertyFilter
      },
      "required": [
        "none"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "every": RollupSubfilterPropertyFilter
      },
      "required": [
        "every"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "date": DatePropertyFilter
      },
      "required": [
        "date"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "number": NumberPropertyFilter
      },
      "required": [
        "number"
      ],
      "additionalProperties": false
    }
  ]
};

export const PropertyFilter: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "title": TextPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "title"
        }
      },
      "required": [
        "title",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "rich_text": TextPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "rich_text"
        }
      },
      "required": [
        "rich_text",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "number": NumberPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "number"
        }
      },
      "required": [
        "number",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "checkbox": CheckboxPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "checkbox"
        }
      },
      "required": [
        "checkbox",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "select": SelectPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "select"
        }
      },
      "required": [
        "select",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "multi_select": MultiSelectPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "multi_select"
        }
      },
      "required": [
        "multi_select",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "status": StatusPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "status"
        }
      },
      "required": [
        "status",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "date": DatePropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "date"
        }
      },
      "required": [
        "date",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "people": PeoplePropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "people"
        }
      },
      "required": [
        "people",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "files": ExistencePropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "files"
        }
      },
      "required": [
        "files",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "url": TextPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "url"
        }
      },
      "required": [
        "url",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "email": TextPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "email"
        }
      },
      "required": [
        "email",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "phone_number": TextPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "phone_number"
        }
      },
      "required": [
        "phone_number",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "relation": RelationPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "relation"
        }
      },
      "required": [
        "relation",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "created_by": PeoplePropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "created_by"
        }
      },
      "required": [
        "created_by",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "created_time": DatePropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "created_time"
        }
      },
      "required": [
        "created_time",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "last_edited_by": PeoplePropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "last_edited_by"
        }
      },
      "required": [
        "last_edited_by",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "last_edited_time": DatePropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "last_edited_time"
        }
      },
      "required": [
        "last_edited_time",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "formula": FormulaPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "formula"
        }
      },
      "required": [
        "formula",
        "property"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "rollup": RollupPropertyFilter,
        "property": {
          "type": "string"
        },
        "type": {
          "type": "string",
          "const": "rollup"
        }
      },
      "required": [
        "rollup",
        "property"
      ],
      "additionalProperties": false
    }
  ]
};

export const TimestampCreatedTimeFilter: JSONSchema = {
  "type": "object",
  "properties": {
    "created_time": DatePropertyFilter,
    "timestamp": {
      "type": "string",
      "const": "created_time"
    },
    "type": {
      "type": "string",
      "const": "created_time"
    }
  },
  "required": [
    "created_time",
    "timestamp"
  ],
  "additionalProperties": false
};

export const TimestampLastEditedTimeFilter: JSONSchema = {
  "type": "object",
  "properties": {
    "last_edited_time": DatePropertyFilter,
    "timestamp": {
      "type": "string",
      "const": "last_edited_time"
    },
    "type": {
      "type": "string",
      "const": "last_edited_time"
    }
  },
  "required": [
    "last_edited_time",
    "timestamp"
  ],
  "additionalProperties": false
};