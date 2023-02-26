import { JSONSchema } from "core/schemas/types";

export const UpdateDatabasePathParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "database_id": IdRequest
  },
  "required": [
    "database_id"
  ],
  "additionalProperties": false
};

export const UpdateDatabaseParametersProperties: JSONSchema = {
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "object",
        "properties": {
          "number": {
            "type": "object",
            "properties": {
              "format": NumberFormat
            },
            "additionalProperties": false
          },
          "type": {
            "type": "string",
            "const": "number"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "number"
        ],
        "additionalProperties": false
      },
      {
        "type": "null"
      },
      {
        "type": "object",
        "properties": {
          "formula": {
            "type": "object",
            "properties": {
              "expression": {
                "type": "string"
              }
            },
            "additionalProperties": false
          },
          "type": {
            "type": "string",
            "const": "formula"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "formula"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "select": {
            "type": "object",
            "properties": {
              "options": {
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "id": StringRequest,
                        "name": StringRequest,
                        "color": SelectColor
                      },
                      "required": [
                        "id"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "name": StringRequest,
                        "id": StringRequest,
                        "color": SelectColor
                      },
                      "required": [
                        "name"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              }
            },
            "additionalProperties": false
          },
          "type": {
            "type": "string",
            "const": "select"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "select"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "multi_select": {
            "type": "object",
            "properties": {
              "options": {
                "type": "array",
                "items": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "id": StringRequest,
                        "name": StringRequest,
                        "color": SelectColor
                      },
                      "required": [
                        "id"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "name": StringRequest,
                        "id": StringRequest,
                        "color": SelectColor
                      },
                      "required": [
                        "name"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              }
            },
            "additionalProperties": false
          },
          "type": {
            "type": "string",
            "const": "multi_select"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "multi_select"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "status": EmptyObject,
          "type": {
            "type": "string",
            "const": "status"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "status"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "relation": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "single_property": EmptyObject,
                  "database_id": IdRequest,
                  "type": {
                    "type": "string",
                    "const": "single_property"
                  }
                },
                "required": [
                  "single_property",
                  "database_id"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "dual_property": NeverRecord,
                  "database_id": IdRequest,
                  "type": {
                    "type": "string",
                    "const": "dual_property"
                  }
                },
                "required": [
                  "dual_property",
                  "database_id"
                ],
                "additionalProperties": false
              }
            ]
          },
          "type": {
            "type": "string",
            "const": "relation"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "relation"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "rollup": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "rollup_property_name": {
                    "type": "string"
                  },
                  "relation_property_name": {
                    "type": "string"
                  },
                  "function": RollupFunction,
                  "rollup_property_id": {
                    "type": "string"
                  },
                  "relation_property_id": {
                    "type": "string"
                  }
                },
                "required": [
                  "rollup_property_name",
                  "relation_property_name",
                  "function"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "rollup_property_name": {
                    "type": "string"
                  },
                  "relation_property_id": {
                    "type": "string"
                  },
                  "function": RollupFunction,
                  "relation_property_name": {
                    "type": "string"
                  },
                  "rollup_property_id": {
                    "type": "string"
                  }
                },
                "required": [
                  "rollup_property_name",
                  "relation_property_id",
                  "function"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "relation_property_name": {
                    "type": "string"
                  },
                  "rollup_property_id": {
                    "type": "string"
                  },
                  "function": RollupFunction,
                  "rollup_property_name": {
                    "type": "string"
                  },
                  "relation_property_id": {
                    "type": "string"
                  }
                },
                "required": [
                  "relation_property_name",
                  "rollup_property_id",
                  "function"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "rollup_property_id": {
                    "type": "string"
                  },
                  "relation_property_id": {
                    "type": "string"
                  },
                  "function": RollupFunction,
                  "rollup_property_name": {
                    "type": "string"
                  },
                  "relation_property_name": {
                    "type": "string"
                  }
                },
                "required": [
                  "rollup_property_id",
                  "relation_property_id",
                  "function"
                ],
                "additionalProperties": false
              }
            ]
          },
          "type": {
            "type": "string",
            "const": "rollup"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "rollup"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "title": EmptyObject,
          "type": {
            "type": "string",
            "const": "title"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "title"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "rich_text": EmptyObject,
          "type": {
            "type": "string",
            "const": "rich_text"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "rich_text"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "url": EmptyObject,
          "type": {
            "type": "string",
            "const": "url"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "url"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "people": EmptyObject,
          "type": {
            "type": "string",
            "const": "people"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "people"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "files": EmptyObject,
          "type": {
            "type": "string",
            "const": "files"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "files"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "email": EmptyObject,
          "type": {
            "type": "string",
            "const": "email"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "email"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "phone_number": EmptyObject,
          "type": {
            "type": "string",
            "const": "phone_number"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "phone_number"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "date": EmptyObject,
          "type": {
            "type": "string",
            "const": "date"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "date"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "checkbox": EmptyObject,
          "type": {
            "type": "string",
            "const": "checkbox"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "checkbox"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "created_by": EmptyObject,
          "type": {
            "type": "string",
            "const": "created_by"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "created_by"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "created_time": EmptyObject,
          "type": {
            "type": "string",
            "const": "created_time"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "created_time"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "last_edited_by": EmptyObject,
          "type": {
            "type": "string",
            "const": "last_edited_by"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "last_edited_by"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "last_edited_time": EmptyObject,
          "type": {
            "type": "string",
            "const": "last_edited_time"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "last_edited_time"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          }
        },
        "required": [
          "name"
        ],
        "additionalProperties": false
      }
    ]
  }
};

export const UpdateDatabaseBodyParameters: JSONSchema = {
  "type": "object",
  "properties": {
    "title": {
      "type": "array",
      "items": RichTextItemRequest
    },
    "description": {
      "type": "array",
      "items": RichTextItemRequest
    },
    "icon": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "emoji": EmojiRequest,
            "type": {
              "type": "string",
              "const": "emoji"
            }
          },
          "required": [
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
            "type": {
              "type": "string",
              "const": "external"
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        }
      ]
    },
    "cover": {
      "anyOf": [
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
            "type": {
              "type": "string",
              "const": "external"
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "properties": UpdateDatabaseParametersProperties,
    "is_inline": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    }
  },
  "additionalProperties": false
};



export const UpdateDatabaseParameters: JSONSchema = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "title": {
      "type": "array",
      "items": RichTextItemRequest
    },
    "description": {
      "type": "array",
      "items": RichTextItemRequest
    },
    "icon": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "emoji": EmojiRequest,
            "type": {
              "type": "string",
              "const": "emoji"
            }
          },
          "required": [
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
            "type": {
              "type": "string",
              "const": "external"
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        }
      ]
    },
    "cover": {
      "anyOf": [
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
            "type": {
              "type": "string",
              "const": "external"
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "properties": UpdateDatabaseParametersProperties,
    "is_inline": {
      "type": "boolean"
    },
    "archived": {
      "type": "boolean"
    },
    "database_id": IdRequest
  },
  "required": [
    "database_id"
  ]
};

export const UpdateDatabaseResponse: JSONSchema = {
  "anyOf": [
    PartialDatabaseObjectResponse,
    DatabaseObjectResponse
  ]
};