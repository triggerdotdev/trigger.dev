import { JSONSchema } from "core/schemas/types";

export const NumberPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "number"
    },
    "number": {
      "type": [
        "number",
        "null"
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "number",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const UrlPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "url"
    },
    "url": {
      "type": [
        "string",
        "null"
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "url",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const SelectPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "select"
    },
    "select": {
      "anyOf": [
        SelectPropertyResponse,
        {
          "type": "null"
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "select",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const MultiSelectPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "multi_select"
    },
    "multi_select": {
      "type": "array",
      "items": SelectPropertyResponse
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "multi_select",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const StatusPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "status"
    },
    "status": {
      "anyOf": [
        SelectPropertyResponse,
        {
          "type": "null"
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "status",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const DatePropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "date"
    },
    "date": {
      "anyOf": [
        DateResponse,
        {
          "type": "null"
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "date",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const EmailPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "email"
    },
    "email": {
      "type": [
        "string",
        "null"
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "email",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const PhoneNumberPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "phone_number"
    },
    "phone_number": {
      "type": [
        "string",
        "null"
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "phone_number",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const CheckboxPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "checkbox"
    },
    "checkbox": {
      "type": "boolean"
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "checkbox",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const FilesPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "files"
    },
    "files": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "file": {
                "type": "object",
                "properties": {
                  "url": {
                    "type": "string"
                  },
                  "expiry_time": {
                    "type": "string"
                  }
                },
                "required": [
                  "url",
                  "expiry_time"
                ],
                "additionalProperties": false
              },
              "name": StringRequest,
              "type": {
                "type": "string",
                "const": "file"
              }
            },
            "required": [
              "file",
              "name"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "external": {
                "type": "object",
                "properties": {
                  "url": TextRequest
                },
                "required": [
                  "url"
                ],
                "additionalProperties": false
              },
              "name": StringRequest,
              "type": {
                "type": "string",
                "const": "external"
              }
            },
            "required": [
              "external",
              "name"
            ],
            "additionalProperties": false
          }
        ]
      }
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "files",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const CreatedByPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "created_by"
    },
    "created_by": {
      "anyOf": [
        PartialUserObjectResponse,
        UserObjectResponse
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "created_by",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const CreatedTimePropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "created_time"
    },
    "created_time": {
      "type": "string"
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "created_time",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const LastEditedByPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "last_edited_by"
    },
    "last_edited_by": {
      "anyOf": [
        PartialUserObjectResponse,
        UserObjectResponse
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "last_edited_by",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const LastEditedTimePropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "last_edited_time"
    },
    "last_edited_time": {
      "type": "string"
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "last_edited_time",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const FormulaPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "formula"
    },
    "formula": FormulaPropertyResponse,
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "formula",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const TitlePropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "title"
    },
    "title": RichTextItemResponse,
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "title",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const RichTextPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "rich_text"
    },
    "rich_text": RichTextItemResponse,
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "rich_text",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const PeoplePropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "people"
    },
    "people": {
      "anyOf": [
        PartialUserObjectResponse,
        UserObjectResponse
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "people",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const RelationPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "relation"
    },
    "relation": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "relation",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const RollupPropertyItemObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "rollup"
    },
    "rollup": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "number"
            },
            "number": {
              "type": [
                "number",
                "null"
              ]
            },
            "function": RollupFunction
          },
          "required": [
            "type",
            "number",
            "function"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "date"
            },
            "date": {
              "anyOf": [
                DateResponse,
                {
                  "type": "null"
                }
              ]
            },
            "function": RollupFunction
          },
          "required": [
            "type",
            "date",
            "function"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "array"
            },
            "array": {
              "type": "array",
              "items": EmptyObject
            },
            "function": RollupFunction
          },
          "required": [
            "type",
            "array",
            "function"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "unsupported"
            },
            "unsupported": EmptyObject,
            "function": RollupFunction
          },
          "required": [
            "type",
            "unsupported",
            "function"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "incomplete"
            },
            "incomplete": EmptyObject,
            "function": RollupFunction
          },
          "required": [
            "type",
            "incomplete",
            "function"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "property_item"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "rollup",
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const PropertyItemObjectResponse: JSONSchema = {
  "anyOf": [
    NumberPropertyItemObjectResponse,
    UrlPropertyItemObjectResponse,
    SelectPropertyItemObjectResponse,
    MultiSelectPropertyItemObjectResponse,
    StatusPropertyItemObjectResponse,
    DatePropertyItemObjectResponse,
    EmailPropertyItemObjectResponse,
    PhoneNumberPropertyItemObjectResponse,
    CheckboxPropertyItemObjectResponse,
    FilesPropertyItemObjectResponse,
    CreatedByPropertyItemObjectResponse,
    CreatedTimePropertyItemObjectResponse,
    LastEditedByPropertyItemObjectResponse,
    LastEditedTimePropertyItemObjectResponse,
    FormulaPropertyItemObjectResponse,
    TitlePropertyItemObjectResponse,
    RichTextPropertyItemObjectResponse,
    PeoplePropertyItemObjectResponse,
    RelationPropertyItemObjectResponse,
    RollupPropertyItemObjectResponse
  ]
};

export const CommentObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "object": {
      "type": "string",
      "const": "comment"
    },
    "id": {
      "type": "string"
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": IdRequest
          },
          "required": [
            "type",
            "page_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "block_id"
            },
            "block_id": IdRequest
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        }
      ]
    },
    "discussion_id": {
      "type": "string"
    },
    "rich_text": {
      "type": "array",
      "items": RichTextItemResponse
    },
    "created_by": PartialUserObjectResponse,
    "created_time": {
      "type": "string"
    },
    "last_edited_time": {
      "type": "string"
    }
  },
  "required": [
    "object",
    "id",
    "parent",
    "discussion_id",
    "rich_text",
    "created_by",
    "created_time",
    "last_edited_time"
  ],
  "additionalProperties": false
};

export const PartialCommentObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "object": {
      "type": "string",
      "const": "comment"
    },
    "id": {
      "type": "string"
    }
  },
  "required": [
    "object",
    "id"
  ],
  "additionalProperties": false
};

export const PropertyItemPropertyItemListResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "property_item"
    },
    "property_item": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "title"
            },
            "title": EmptyObject,
            "next_url": {
              "type": [
                "string",
                "null"
              ]
            },
            "id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "title",
            "next_url",
            "id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "rich_text"
            },
            "rich_text": EmptyObject,
            "next_url": {
              "type": [
                "string",
                "null"
              ]
            },
            "id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "rich_text",
            "next_url",
            "id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "people"
            },
            "people": EmptyObject,
            "next_url": {
              "type": [
                "string",
                "null"
              ]
            },
            "id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "people",
            "next_url",
            "id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "relation"
            },
            "relation": EmptyObject,
            "next_url": {
              "type": [
                "string",
                "null"
              ]
            },
            "id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "relation",
            "next_url",
            "id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "rollup"
            },
            "rollup": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "number"
                    },
                    "number": {
                      "type": [
                        "number",
                        "null"
                      ]
                    },
                    "function": RollupFunction
                  },
                  "required": [
                    "type",
                    "number",
                    "function"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "date"
                    },
                    "date": {
                      "anyOf": [
                        DateResponse,
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "function": RollupFunction
                  },
                  "required": [
                    "type",
                    "date",
                    "function"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "array"
                    },
                    "array": {
                      "type": "array",
                      "items": EmptyObject
                    },
                    "function": RollupFunction
                  },
                  "required": [
                    "type",
                    "array",
                    "function"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "unsupported"
                    },
                    "unsupported": EmptyObject,
                    "function": RollupFunction
                  },
                  "required": [
                    "type",
                    "unsupported",
                    "function"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "incomplete"
                    },
                    "incomplete": EmptyObject,
                    "function": RollupFunction
                  },
                  "required": [
                    "type",
                    "incomplete",
                    "function"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "next_url": {
              "type": [
                "string",
                "null"
              ]
            },
            "id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "rollup",
            "next_url",
            "id"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "list"
    },
    "next_cursor": {
      "type": [
        "string",
        "null"
      ]
    },
    "has_more": {
      "type": "boolean"
    },
    "results": {
      "type": "array",
      "items": PropertyItemObjectResponse
    }
  },
  "required": [
    "type",
    "property_item",
    "object",
    "next_cursor",
    "has_more",
    "results"
  ],
  "additionalProperties": false
};

export const PropertyItemListResponse: JSONSchema = PropertyItemPropertyItemListResponse;