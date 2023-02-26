import { JSONSchema } from "core/schemas/types";

export const PersonUserObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "person"
    },
    "person": {
      "type": "object",
      "properties": {
        "email": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "name": {
      "type": [
        "string",
        "null"
      ]
    },
    "avatar_url": {
      "type": [
        "string",
        "null"
      ]
    },
    "id": IdRequest,
    "object": {
      "type": "string",
      "const": "user"
    }
  },
  "required": [
    "type",
    "person",
    "name",
    "avatar_url",
    "id",
    "object"
  ],
  "additionalProperties": false
};

export const PartialUserObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "id": IdRequest,
    "object": {
      "type": "string",
      "const": "user"
    }
  },
  "required": [
    "id",
    "object"
  ],
  "additionalProperties": false
};

export const BotUserObjectResponse: JSONSchema = {
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "bot"
    },
    "bot": {
      "anyOf": [
        EmptyObject,
        {
          "type": "object",
          "properties": {
            "owner": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "user"
                    },
                    "user": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "const": "person"
                            },
                            "person": {
                              "type": "object",
                              "properties": {
                                "email": {
                                  "type": "string"
                                }
                              },
                              "required": [
                                "email"
                              ],
                              "additionalProperties": false
                            },
                            "name": {
                              "type": [
                                "string",
                                "null"
                              ]
                            },
                            "avatar_url": {
                              "type": [
                                "string",
                                "null"
                              ]
                            },
                            "id": IdRequest,
                            "object": {
                              "type": "string",
                              "const": "user"
                            }
                          },
                          "required": [
                            "type",
                            "person",
                            "name",
                            "avatar_url",
                            "id",
                            "object"
                          ],
                          "additionalProperties": false
                        },
                        PartialUserObjectResponse
                      ]
                    }
                  },
                  "required": [
                    "type",
                    "user"
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
            "workspace_name": {
              "type": [
                "string",
                "null"
              ]
            }
          },
          "required": [
            "owner",
            "workspace_name"
          ],
          "additionalProperties": false
        }
      ]
    },
    "name": {
      "type": [
        "string",
        "null"
      ]
    },
    "avatar_url": {
      "type": [
        "string",
        "null"
      ]
    },
    "id": IdRequest,
    "object": {
      "type": "string",
      "const": "user"
    }
  },
  "required": [
    "type",
    "bot",
    "name",
    "avatar_url",
    "id",
    "object"
  ],
  "additionalProperties": false
};

export const UserObjectResponse: JSONSchema = {
  "anyOf": [
    PersonUserObjectResponse,
    BotUserObjectResponse
  ]
};





