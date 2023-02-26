import { JSONSchema } from "core/schemas/types";

export const PartialBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "object": {
      "type": "string",
      "const": "block"
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

export const ParagraphBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "paragraph"
    },
    "paragraph": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor
      },
      "required": [
        "rich_text",
        "color"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "paragraph",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const Heading1BlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "heading_1"
    },
    "heading_1": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor
      },
      "required": [
        "rich_text",
        "color"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "heading_1",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const Heading2BlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "heading_2"
    },
    "heading_2": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor
      },
      "required": [
        "rich_text",
        "color"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "heading_2",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const Heading3BlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "heading_3"
    },
    "heading_3": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor
      },
      "required": [
        "rich_text",
        "color"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "heading_3",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const BulletedListItemBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "bulleted_list_item"
    },
    "bulleted_list_item": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor
      },
      "required": [
        "rich_text",
        "color"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "bulleted_list_item",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const NumberedListItemBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "numbered_list_item"
    },
    "numbered_list_item": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor
      },
      "required": [
        "rich_text",
        "color"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "numbered_list_item",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const QuoteBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "quote"
    },
    "quote": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor
      },
      "required": [
        "rich_text",
        "color"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "quote",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const ToDoBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "to_do"
    },
    "to_do": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor,
        "checked": {
          "type": "boolean"
        }
      },
      "required": [
        "rich_text",
        "color",
        "checked"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "to_do",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const ToggleBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "toggle"
    },
    "toggle": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor
      },
      "required": [
        "rich_text",
        "color"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "toggle",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const TemplateBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "template"
    },
    "template": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        }
      },
      "required": [
        "rich_text"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "template",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const SyncedBlockBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "synced_block"
    },
    "synced_block": {
      "type": "object",
      "properties": {
        "synced_from": {
          "anyOf": [
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
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "synced_from"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "synced_block",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const ChildPageBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "child_page"
    },
    "child_page": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "child_page",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const ChildDatabaseBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "child_database"
    },
    "child_database": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "child_database",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const EquationBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "equation"
    },
    "equation": {
      "type": "object",
      "properties": {
        "expression": {
          "type": "string"
        }
      },
      "required": [
        "expression"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "equation",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const LanguageRequest: JSONSchema = {
  "type": "string",
  "enum": [
    "abap",
    "agda",
    "arduino",
    "assembly",
    "bash",
    "basic",
    "bnf",
    "c",
    "c#",
    "c++",
    "clojure",
    "coffeescript",
    "coq",
    "css",
    "dart",
    "dhall",
    "diff",
    "docker",
    "ebnf",
    "elixir",
    "elm",
    "erlang",
    "f#",
    "flow",
    "fortran",
    "gherkin",
    "glsl",
    "go",
    "graphql",
    "groovy",
    "haskell",
    "html",
    "idris",
    "java",
    "javascript",
    "json",
    "julia",
    "kotlin",
    "latex",
    "less",
    "lisp",
    "livescript",
    "llvm ir",
    "lua",
    "makefile",
    "markdown",
    "markup",
    "matlab",
    "mathematica",
    "mermaid",
    "nix",
    "objective-c",
    "ocaml",
    "pascal",
    "perl",
    "php",
    "plain text",
    "powershell",
    "prolog",
    "protobuf",
    "purescript",
    "python",
    "r",
    "racket",
    "reason",
    "ruby",
    "rust",
    "sass",
    "scala",
    "scheme",
    "scss",
    "shell",
    "solidity",
    "sql",
    "swift",
    "toml",
    "typescript",
    "vb.net",
    "verilog",
    "vhdl",
    "visual basic",
    "webassembly",
    "xml",
    "yaml",
    "java/c/c++/c#"
  ]
};

export const CodeBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "code"
    },
    "code": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "caption": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "language": LanguageRequest
      },
      "required": [
        "rich_text",
        "caption",
        "language"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "code",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const CalloutBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "callout"
    },
    "callout": {
      "type": "object",
      "properties": {
        "rich_text": {
          "type": "array",
          "items": RichTextItemResponse
        },
        "color": ApiColor,
        "icon": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "emoji"
                },
                "emoji": EmojiRequest
              },
              "required": [
                "type",
                "emoji"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "external"
                },
                "external": {
                  "type": "object",
                  "properties": {
                    "url": TextRequest
                  },
                  "required": [
                    "url"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "type",
                "external"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "const": "file"
                },
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
                }
              },
              "required": [
                "type",
                "file"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "rich_text",
        "color",
        "icon"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "callout",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const DividerBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "divider"
    },
    "divider": EmptyObject,
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "divider",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const BreadcrumbBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "breadcrumb"
    },
    "breadcrumb": EmptyObject,
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "breadcrumb",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const TableOfContentsBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "table_of_contents"
    },
    "table_of_contents": {
      "type": "object",
      "properties": {
        "color": ApiColor
      },
      "required": [
        "color"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "table_of_contents",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const ColumnListBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "column_list"
    },
    "column_list": EmptyObject,
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "column_list",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const ColumnBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "column"
    },
    "column": EmptyObject,
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "column",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const LinkToPageBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "link_to_page"
    },
    "link_to_page": {
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
              "const": "database_id"
            },
            "database_id": IdRequest
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "comment_id"
            },
            "comment_id": IdRequest
          },
          "required": [
            "type",
            "comment_id"
          ],
          "additionalProperties": false
        }
      ]
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "link_to_page",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const TableBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "table"
    },
    "table": {
      "type": "object",
      "properties": {
        "has_column_header": {
          "type": "boolean"
        },
        "has_row_header": {
          "type": "boolean"
        },
        "table_width": {
          "type": "number"
        }
      },
      "required": [
        "has_column_header",
        "has_row_header",
        "table_width"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "table",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const TableRowBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "table_row"
    },
    "table_row": {
      "type": "object",
      "properties": {
        "cells": {
          "type": "array",
          "items": {
            "type": "array",
            "items": RichTextItemResponse
          }
        }
      },
      "required": [
        "cells"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "table_row",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const EmbedBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "embed"
    },
    "embed": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string"
        },
        "caption": {
          "type": "array",
          "items": RichTextItemResponse
        }
      },
      "required": [
        "url",
        "caption"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "embed",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const BookmarkBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "bookmark"
    },
    "bookmark": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string"
        },
        "caption": {
          "type": "array",
          "items": RichTextItemResponse
        }
      },
      "required": [
        "url",
        "caption"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "bookmark",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const ImageBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "image"
    },
    "image": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "external"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "external",
            "caption"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "file"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "file",
            "caption"
          ],
          "additionalProperties": false
        }
      ]
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "image",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const VideoBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "video"
    },
    "video": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "external"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "external",
            "caption"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "file"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "file",
            "caption"
          ],
          "additionalProperties": false
        }
      ]
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "video",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const PdfBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "pdf"
    },
    "pdf": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "external"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "external",
            "caption"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "file"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "file",
            "caption"
          ],
          "additionalProperties": false
        }
      ]
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "pdf",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const FileBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "file"
    },
    "file": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "external"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "external",
            "caption"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "file"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "file",
            "caption"
          ],
          "additionalProperties": false
        }
      ]
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "file",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const AudioBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "audio"
    },
    "audio": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "external"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "external",
            "caption"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "file"
            },
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
            "caption": {
              "type": "array",
              "items": RichTextItemResponse
            }
          },
          "required": [
            "type",
            "file",
            "caption"
          ],
          "additionalProperties": false
        }
      ]
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "audio",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const LinkPreviewBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "link_preview"
    },
    "link_preview": {
      "type": "object",
      "properties": {
        "url": TextRequest
      },
      "required": [
        "url"
      ],
      "additionalProperties": false
    },
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "link_preview",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const UnsupportedBlockObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "unsupported"
    },
    "unsupported": EmptyObject,
    "parent": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "database_id"
            },
            "database_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "database_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "page_id"
            },
            "page_id": {
              "type": "string"
            }
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
            "block_id": {
              "type": "string"
            }
          },
          "required": [
            "type",
            "block_id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "const": "workspace"
            },
            "workspace": {
              "type": "boolean",
              "const": true
            }
          },
          "required": [
            "type",
            "workspace"
          ],
          "additionalProperties": false
        }
      ]
    },
    "object": {
      "type": "string",
      "const": "block"
    },
    "id": {
      "type": "string"
    },
    "created_time": {
      "type": "string"
    },
    "created_by": PartialUserObjectResponse,
    "last_edited_time": {
      "type": "string"
    },
    "last_edited_by": PartialUserObjectResponse,
    "has_children": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "required": [
    "type",
    "unsupported",
    "parent",
    "object",
    "id",
    "created_time",
    "created_by",
    "last_edited_time",
    "last_edited_by",
    "has_children",
    "archived"
  ],
  "additionalProperties": false
};

export const BlockObjectResponse: JSONSchema = {
  "anyOf": [
    ParagraphBlockObjectResponse,
    Heading1BlockObjectResponse,
    Heading2BlockObjectResponse,
    Heading3BlockObjectResponse,
    BulletedListItemBlockObjectResponse,
    NumberedListItemBlockObjectResponse,
    QuoteBlockObjectResponse,
    ToDoBlockObjectResponse,
    ToggleBlockObjectResponse,
    TemplateBlockObjectResponse,
    SyncedBlockBlockObjectResponse,
    ChildPageBlockObjectResponse,
    ChildDatabaseBlockObjectResponse,
    EquationBlockObjectResponse,
    CodeBlockObjectResponse,
    CalloutBlockObjectResponse,
    DividerBlockObjectResponse,
    BreadcrumbBlockObjectResponse,
    TableOfContentsBlockObjectResponse,
    ColumnListBlockObjectResponse,
    ColumnBlockObjectResponse,
    LinkToPageBlockObjectResponse,
    TableBlockObjectResponse,
    TableRowBlockObjectResponse,
    EmbedBlockObjectResponse,
    BookmarkBlockObjectResponse,
    ImageBlockObjectResponse,
    VideoBlockObjectResponse,
    PdfBlockObjectResponse,
    FileBlockObjectResponse,
    AudioBlockObjectResponse,
    LinkPreviewBlockObjectResponse,
    UnsupportedBlockObjectResponse
  ]
};