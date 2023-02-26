import { JSONSchema } from "core/schemas/types";

export const BlockObjectRequestWithoutChildren: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "embed": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string"
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "url"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "embed"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "embed"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "bookmark": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string"
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "url"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "bookmark"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "bookmark"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "image": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "image"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "image"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "video": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "video"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "video"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "pdf": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "pdf"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "pdf"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "file": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "file"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "file"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "audio": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "audio"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "audio"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "code": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "language": LanguageRequest,
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "rich_text",
            "language"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "code"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "code"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
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
        "type": {
          "type": "string",
          "const": "equation"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "equation"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "divider": EmptyObject,
        "type": {
          "type": "string",
          "const": "divider"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "divider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "breadcrumb": EmptyObject,
        "type": {
          "type": "string",
          "const": "breadcrumb"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "breadcrumb"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "table_of_contents": {
          "type": "object",
          "properties": {
            "color": ApiColor
          },
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "table_of_contents"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "table_of_contents"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "link_to_page": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "page_id": IdRequest,
                "type": {
                  "type": "string",
                  "const": "page_id"
                }
              },
              "required": [
                "page_id"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "database_id": IdRequest,
                "type": {
                  "type": "string",
                  "const": "database_id"
                }
              },
              "required": [
                "database_id"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "comment_id": IdRequest,
                "type": {
                  "type": "string",
                  "const": "comment_id"
                }
              },
              "required": [
                "comment_id"
              ],
              "additionalProperties": false
            }
          ]
        },
        "type": {
          "type": "string",
          "const": "link_to_page"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "link_to_page"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "table_row": {
          "type": "object",
          "properties": {
            "cells": {
              "type": "array",
              "items": {
                "type": "array",
                "items": RichTextItemRequest
              }
            }
          },
          "required": [
            "cells"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "table_row"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "table_row"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "heading_1": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "is_toggleable": {
              "type": "boolean"
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "heading_1"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "heading_1"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "heading_2": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "is_toggleable": {
              "type": "boolean"
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "heading_2"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "heading_2"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "heading_3": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "is_toggleable": {
              "type": "boolean"
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "heading_3"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "heading_3"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "paragraph": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "paragraph"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "paragraph"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "bulleted_list_item": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "bulleted_list_item"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "bulleted_list_item"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "numbered_list_item": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "numbered_list_item"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "numbered_list_item"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "quote": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "quote"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "quote"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "to_do": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "checked": {
              "type": "boolean"
            },
            "color": ApiColor
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "to_do"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "to_do"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "toggle": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "toggle"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "toggle"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "template": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "template"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "template"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "callout": {
          "type": "object",
          "properties": {
            "rich_text": {
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
            "color": ApiColor
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "callout"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "callout"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "synced_block": {
          "type": "object",
          "properties": {
            "synced_from": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "block_id": IdRequest,
                    "type": {
                      "type": "string",
                      "const": "block_id"
                    }
                  },
                  "required": [
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
        "type": {
          "type": "string",
          "const": "synced_block"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "synced_block"
      ],
      "additionalProperties": false
    }
  ]
};

export const BlockObjectRequest: JSONSchema = {
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "embed": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string"
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "url"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "embed"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "embed"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "bookmark": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string"
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "url"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "bookmark"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "bookmark"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "image": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "image"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "image"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "video": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "video"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "video"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "pdf": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "pdf"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "pdf"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "file": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "file"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "file"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "audio": {
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
            },
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "external"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "audio"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "audio"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "code": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "language": LanguageRequest,
            "caption": {
              "type": "array",
              "items": RichTextItemRequest
            }
          },
          "required": [
            "rich_text",
            "language"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "code"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "code"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
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
        "type": {
          "type": "string",
          "const": "equation"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "equation"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "divider": EmptyObject,
        "type": {
          "type": "string",
          "const": "divider"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "divider"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "breadcrumb": EmptyObject,
        "type": {
          "type": "string",
          "const": "breadcrumb"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "breadcrumb"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "table_of_contents": {
          "type": "object",
          "properties": {
            "color": ApiColor
          },
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "table_of_contents"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "table_of_contents"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "link_to_page": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "page_id": IdRequest,
                "type": {
                  "type": "string",
                  "const": "page_id"
                }
              },
              "required": [
                "page_id"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "database_id": IdRequest,
                "type": {
                  "type": "string",
                  "const": "database_id"
                }
              },
              "required": [
                "database_id"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "comment_id": IdRequest,
                "type": {
                  "type": "string",
                  "const": "comment_id"
                }
              },
              "required": [
                "comment_id"
              ],
              "additionalProperties": false
            }
          ]
        },
        "type": {
          "type": "string",
          "const": "link_to_page"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "link_to_page"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "table_row": {
          "type": "object",
          "properties": {
            "cells": {
              "type": "array",
              "items": {
                "type": "array",
                "items": RichTextItemRequest
              }
            }
          },
          "required": [
            "cells"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "table_row"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "table_row"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "column_list": {
          "type": "object",
          "properties": {
            "children": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "column": {
                    "type": "object",
                    "properties": {
                      "children": {
                        "type": "array",
                        "items": {
                          "anyOf": [
                            {
                              "type": "object",
                              "properties": {
                                "embed": {
                                  "type": "object",
                                  "properties": {
                                    "url": {
                                      "type": "string"
                                    },
                                    "caption": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    }
                                  },
                                  "required": [
                                    "url"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "embed"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "embed"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "bookmark": {
                                  "type": "object",
                                  "properties": {
                                    "url": {
                                      "type": "string"
                                    },
                                    "caption": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    }
                                  },
                                  "required": [
                                    "url"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "bookmark"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "bookmark"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "image": {
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
                                    },
                                    "caption": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    }
                                  },
                                  "required": [
                                    "external"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "image"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "image"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "video": {
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
                                    },
                                    "caption": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    }
                                  },
                                  "required": [
                                    "external"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "video"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "video"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "pdf": {
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
                                    },
                                    "caption": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    }
                                  },
                                  "required": [
                                    "external"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "pdf"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "pdf"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "file": {
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
                                    },
                                    "caption": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    }
                                  },
                                  "required": [
                                    "external"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "file"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "file"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "audio": {
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
                                    },
                                    "caption": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    }
                                  },
                                  "required": [
                                    "external"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "audio"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "audio"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "code": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "language": LanguageRequest,
                                    "caption": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    }
                                  },
                                  "required": [
                                    "rich_text",
                                    "language"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "code"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "code"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
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
                                "type": {
                                  "type": "string",
                                  "const": "equation"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "equation"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "divider": EmptyObject,
                                "type": {
                                  "type": "string",
                                  "const": "divider"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "divider"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "breadcrumb": EmptyObject,
                                "type": {
                                  "type": "string",
                                  "const": "breadcrumb"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "breadcrumb"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "table_of_contents": {
                                  "type": "object",
                                  "properties": {
                                    "color": ApiColor
                                  },
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "table_of_contents"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "table_of_contents"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "link_to_page": {
                                  "anyOf": [
                                    {
                                      "type": "object",
                                      "properties": {
                                        "page_id": IdRequest,
                                        "type": {
                                          "type": "string",
                                          "const": "page_id"
                                        }
                                      },
                                      "required": [
                                        "page_id"
                                      ],
                                      "additionalProperties": false
                                    },
                                    {
                                      "type": "object",
                                      "properties": {
                                        "database_id": IdRequest,
                                        "type": {
                                          "type": "string",
                                          "const": "database_id"
                                        }
                                      },
                                      "required": [
                                        "database_id"
                                      ],
                                      "additionalProperties": false
                                    },
                                    {
                                      "type": "object",
                                      "properties": {
                                        "comment_id": IdRequest,
                                        "type": {
                                          "type": "string",
                                          "const": "comment_id"
                                        }
                                      },
                                      "required": [
                                        "comment_id"
                                      ],
                                      "additionalProperties": false
                                    }
                                  ]
                                },
                                "type": {
                                  "type": "string",
                                  "const": "link_to_page"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "link_to_page"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "table_row": {
                                  "type": "object",
                                  "properties": {
                                    "cells": {
                                      "type": "array",
                                      "items": {
                                        "type": "array",
                                        "items": RichTextItemRequest
                                      }
                                    }
                                  },
                                  "required": [
                                    "cells"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "table_row"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "table_row"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "heading_1": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "is_toggleable": {
                                      "type": "boolean"
                                    },
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "heading_1"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "heading_1"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "heading_2": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "is_toggleable": {
                                      "type": "boolean"
                                    },
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "heading_2"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "heading_2"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "heading_3": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "is_toggleable": {
                                      "type": "boolean"
                                    },
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "heading_3"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "heading_3"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "paragraph": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "paragraph"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "paragraph"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "bulleted_list_item": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "bulleted_list_item"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "bulleted_list_item"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "numbered_list_item": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "numbered_list_item"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "numbered_list_item"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "quote": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "quote"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "quote"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "to_do": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    },
                                    "checked": {
                                      "type": "boolean"
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "to_do"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "to_do"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "toggle": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "toggle"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "toggle"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "template": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "template"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "template"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "callout": {
                                  "type": "object",
                                  "properties": {
                                    "rich_text": {
                                      "type": "array",
                                      "items": RichTextItemRequest
                                    },
                                    "color": ApiColor,
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
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
                                    }
                                  },
                                  "required": [
                                    "rich_text"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "callout"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "callout"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "synced_block": {
                                  "type": "object",
                                  "properties": {
                                    "synced_from": {
                                      "anyOf": [
                                        {
                                          "type": "object",
                                          "properties": {
                                            "block_id": IdRequest,
                                            "type": {
                                              "type": "string",
                                              "const": "block_id"
                                            }
                                          },
                                          "required": [
                                            "block_id"
                                          ],
                                          "additionalProperties": false
                                        },
                                        {
                                          "type": "null"
                                        }
                                      ]
                                    },
                                    "children": {
                                      "type": "array",
                                      "items": BlockObjectRequestWithoutChildren
                                    }
                                  },
                                  "required": [
                                    "synced_from"
                                  ],
                                  "additionalProperties": false
                                },
                                "type": {
                                  "type": "string",
                                  "const": "synced_block"
                                },
                                "object": {
                                  "type": "string",
                                  "const": "block"
                                }
                              },
                              "required": [
                                "synced_block"
                              ],
                              "additionalProperties": false
                            }
                          ]
                        }
                      }
                    },
                    "required": [
                      "children"
                    ],
                    "additionalProperties": false
                  },
                  "type": {
                    "type": "string",
                    "const": "column"
                  },
                  "object": {
                    "type": "string",
                    "const": "block"
                  }
                },
                "required": [
                  "column"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "children"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "column_list"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "column_list"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "column": {
          "type": "object",
          "properties": {
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "children"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "column"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "column"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "table": {
          "type": "object",
          "properties": {
            "table_width": {
              "type": "number"
            },
            "children": {
              "type": "array",
              "items": BlockObjectRequestWithoutChildren
            },
            "has_column_header": {
              "type": "boolean"
            },
            "has_row_header": {
              "type": "boolean"
            }
          },
          "required": [
            "table_width",
            "children"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "table"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "table"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "heading_1": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "is_toggleable": {
              "type": "boolean"
            },
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "heading_1"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "heading_1"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "heading_2": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "is_toggleable": {
              "type": "boolean"
            },
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "heading_2"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "heading_2"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "heading_3": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "is_toggleable": {
              "type": "boolean"
            },
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "heading_3"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "heading_3"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "paragraph": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "paragraph"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "paragraph"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "bulleted_list_item": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "bulleted_list_item"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "bulleted_list_item"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "numbered_list_item": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "numbered_list_item"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "numbered_list_item"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "quote": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "quote"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "quote"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "to_do": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            },
            "checked": {
              "type": "boolean"
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "to_do"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "to_do"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "toggle": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "toggle"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "toggle"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "template": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "template"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "template"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "callout": {
          "type": "object",
          "properties": {
            "rich_text": {
              "type": "array",
              "items": RichTextItemRequest
            },
            "color": ApiColor,
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
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
            }
          },
          "required": [
            "rich_text"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "callout"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "callout"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "synced_block": {
          "type": "object",
          "properties": {
            "synced_from": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "block_id": IdRequest,
                    "type": {
                      "type": "string",
                      "const": "block_id"
                    }
                  },
                  "required": [
                    "block_id"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            },
            "children": {
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "embed": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "embed"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "embed"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bookmark": {
                        "type": "object",
                        "properties": {
                          "url": {
                            "type": "string"
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "url"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bookmark"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bookmark"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "image": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "image"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "image"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "video": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "video"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "video"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "pdf": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "pdf"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "pdf"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "file": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "file"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "file"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "audio": {
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
                          },
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "external"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "audio"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "audio"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "language": LanguageRequest,
                          "caption": {
                            "type": "array",
                            "items": RichTextItemRequest
                          }
                        },
                        "required": [
                          "rich_text",
                          "language"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "code"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "code"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
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
                      "type": {
                        "type": "string",
                        "const": "equation"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "equation"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "divider": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "divider"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "divider"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "breadcrumb": EmptyObject,
                      "type": {
                        "type": "string",
                        "const": "breadcrumb"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "breadcrumb"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_of_contents": {
                        "type": "object",
                        "properties": {
                          "color": ApiColor
                        },
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_of_contents"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_of_contents"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "link_to_page": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "page_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "page_id"
                              }
                            },
                            "required": [
                              "page_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "database_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "database_id"
                              }
                            },
                            "required": [
                              "database_id"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "comment_id": IdRequest,
                              "type": {
                                "type": "string",
                                "const": "comment_id"
                              }
                            },
                            "required": [
                              "comment_id"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "type": {
                        "type": "string",
                        "const": "link_to_page"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "link_to_page"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "table_row": {
                        "type": "object",
                        "properties": {
                          "cells": {
                            "type": "array",
                            "items": {
                              "type": "array",
                              "items": RichTextItemRequest
                            }
                          }
                        },
                        "required": [
                          "cells"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "table_row"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "table_row"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_1": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_1"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_1"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_2": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_2"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_2"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "heading_3": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "is_toggleable": {
                            "type": "boolean"
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "heading_3"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "heading_3"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "paragraph": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "paragraph"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "paragraph"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "bulleted_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "bulleted_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "bulleted_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "numbered_list_item": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "numbered_list_item"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "numbered_list_item"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "quote": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "quote"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "quote"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "to_do": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          },
                          "checked": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "to_do"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "to_do"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "toggle": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "toggle"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "toggle"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "template": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "template"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "template"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "callout": {
                        "type": "object",
                        "properties": {
                          "rich_text": {
                            "type": "array",
                            "items": RichTextItemRequest
                          },
                          "color": ApiColor,
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
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
                          }
                        },
                        "required": [
                          "rich_text"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "callout"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "callout"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "synced_block": {
                        "type": "object",
                        "properties": {
                          "synced_from": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "block_id": IdRequest,
                                  "type": {
                                    "type": "string",
                                    "const": "block_id"
                                  }
                                },
                                "required": [
                                  "block_id"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "children": {
                            "type": "array",
                            "items": BlockObjectRequestWithoutChildren
                          }
                        },
                        "required": [
                          "synced_from"
                        ],
                        "additionalProperties": false
                      },
                      "type": {
                        "type": "string",
                        "const": "synced_block"
                      },
                      "object": {
                        "type": "string",
                        "const": "block"
                      }
                    },
                    "required": [
                      "synced_block"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            }
          },
          "required": [
            "synced_from"
          ],
          "additionalProperties": false
        },
        "type": {
          "type": "string",
          "const": "synced_block"
        },
        "object": {
          "type": "string",
          "const": "block"
        }
      },
      "required": [
        "synced_block"
      ],
      "additionalProperties": false
    }
  ]
};