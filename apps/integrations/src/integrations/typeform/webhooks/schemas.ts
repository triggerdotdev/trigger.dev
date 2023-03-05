import {
  makeArraySchema,
  makeBooleanSchema,
  makeNumberSchema,
  makeObjectSchema,
  makeOneOf,
  makeStringSchema,
} from "core/schemas/makeSchema";

//Payload reference here
//https://www.typeform.com/developers/webhooks/example-payload/

function makeAnswerField(types: string[]) {
  let typeField = makeStringSchema("type", `The type of the field`);
  if (types.length === 1) {
    typeField = makeStringSchema("type", `The type of the field`, {
      const: types[0],
    });
  } else if (types.length > 1) {
    typeField = makeStringSchema("type", `The type of the field`, {
      enum: types,
    });
  }

  return makeObjectSchema("field", {
    requiredProperties: {
      id: makeStringSchema("id", `The ID of the field`),
      type: typeField,
    },
    optionalProperties: {
      ref: makeStringSchema("ref", `The ref of the field`),
    },
  });
}

const TextAnswer = makeObjectSchema("text answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "text",
    }),
    text: makeStringSchema("text", `The value of the answer`),
    field: makeAnswerField(["short_text", "long_text"]),
  },
});

const EmailAnswer = makeObjectSchema("email answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "email",
    }),
    email: makeStringSchema("email", `The value of the answer`),
    field: makeAnswerField(["email"]),
  },
});

const DateAnswer = makeObjectSchema("date answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "date",
    }),
    date: makeStringSchema("date", `The value of the answer`),
    field: makeAnswerField(["date"]),
  },
});

const ChoicesAnswer = makeObjectSchema("choices answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "choices",
    }),
    choices: makeObjectSchema("choices", {
      requiredProperties: {
        labels: makeArraySchema(
          "labels",
          makeStringSchema("label", `The label of the choice`)
        ),
      },
      optionalProperties: {
        other: makeStringSchema(
          "label",
          `What the user typed in to the "other" field`
        ),
      },
    }),
    field: makeAnswerField(["picture_choice", "dropdown", "multiple_choice"]),
  },
});

const ChoiceAnswer = makeObjectSchema("choice answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "choice",
    }),
    choice: makeObjectSchema("choice", {
      optionalProperties: {
        label: makeStringSchema("label", `The label of the choice`),
        other: makeStringSchema(
          "label",
          `What the user typed in to the "other" field`
        ),
      },
    }),
    field: makeAnswerField(["picture_choice", "dropdown", "multiple_choice"]),
  },
});

const BooleanAnswer = makeObjectSchema("boolean answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "boolean",
    }),
    boolean: makeBooleanSchema("boolean", `The value of the answer`),
    field: makeAnswerField(["legal", "yes_no"]),
  },
});

const UrlAnswer = makeObjectSchema("url answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "url",
    }),
    url: makeStringSchema("url", `The value of the answer`),
    field: makeAnswerField(["website", "calendly"]),
  },
});

const NumberAnswer = makeObjectSchema("number answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "number",
    }),
    number: makeNumberSchema("number", `The value of the answer`),
    field: makeAnswerField([]),
  },
});

const FileUrlAnswer = makeObjectSchema("file url answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "file_url",
    }),
    file_url: makeStringSchema("file_url", `The value of the answer`),
    field: makeAnswerField(["file_upload"]),
  },
});

const PaymentAnswer = makeObjectSchema("payment answer", {
  requiredProperties: {
    type: makeStringSchema("type", `The type of the answer`, {
      const: "payment",
    }),
    payment: makeObjectSchema("payment", {
      requiredProperties: {
        amount: makeNumberSchema("amount", `The amount of the payment`),
        last4: makeStringSchema("last4", `The last 4 digits of the card`),
        name: makeStringSchema("name", `The name of the credit card`),
        success: makeBooleanSchema("success", `Whether the payment succeeded`),
      },
    }),
    field: makeAnswerField(["payment"]),
  },
});

const Answers = [
  TextAnswer,
  ChoiceAnswer,
  ChoicesAnswer,
  EmailAnswer,
  DateAnswer,
  BooleanAnswer,
  UrlAnswer,
  NumberAnswer,
  FileUrlAnswer,
  PaymentAnswer,
];

export const formEventSchema = makeObjectSchema("form_response", {
  requiredProperties: {
    event_id: makeStringSchema(
      "event_id",
      `The ID of the event that triggered this webhook`
    ),
    event_type: makeStringSchema(
      "event_type",
      `The type of event, always "form_response"`,
      { const: "form_response" }
    ),
    form_response: makeObjectSchema("form_response", {
      requiredProperties: {
        form_id: makeStringSchema(
          "form_id",
          `The ID of the form that was submitted`
        ),
        token: makeStringSchema("token", `The unique token for this response`),
        submitted_at: makeStringSchema(
          "submitted_at",
          `The date and time the response was submitted`
        ),
        landed_at: makeStringSchema(
          "landed_at",
          `The date and time the respondent landed on the form`
        ),
        definition: makeObjectSchema("definition", {
          requiredProperties: {
            id: makeStringSchema("id", `The ID of the form`),
            title: makeStringSchema("title", `The title of the form`),
            fields: makeArraySchema(
              "fields",
              makeObjectSchema("field", {
                requiredProperties: {
                  id: makeStringSchema("id", `The ID of the field`),
                  title: makeStringSchema("title", `The title of the field`),
                  type: makeStringSchema("type", `The type of the field`),
                  ref: makeStringSchema(
                    "ref",
                    "A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to."
                  ),
                },
                optionalProperties: {
                  allow_multiple_selections: makeBooleanSchema(
                    "allow_multiple_selections",
                    "Whether or not the field allows multiple selections"
                  ),
                  allow_other_choice: makeBooleanSchema(
                    "allow_other_choice",
                    "Whether or not the field allows an 'other' choice"
                  ),
                  choices: makeArraySchema(
                    "choices",
                    makeObjectSchema("choice", {
                      requiredProperties: {
                        label: makeStringSchema(
                          "label",
                          "The label of the choice"
                        ),
                        id: makeStringSchema("id", "The ID of the choice"),
                      },
                    })
                  ),
                },
              })
            ),
          },
          optionalProperties: {
            endings: makeArraySchema(
              "endings",
              makeObjectSchema("ending", {
                requiredProperties: {
                  id: makeStringSchema("id", `The ID of the ending`),
                  ref: makeStringSchema(
                    "ref",
                    "A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to."
                  ),
                  title: makeStringSchema("title", `The title of the ending`),
                  type: makeStringSchema("type", `The type of the ending`),
                },
                additionalProperties: true,
              })
            ),
          },
        }),
        answers: makeArraySchema("answers", makeOneOf("answer", Answers)),
        ending: makeObjectSchema("ending", {
          requiredProperties: {
            id: makeStringSchema("id", `The ID of the ending`),
            ref: makeStringSchema(
              "ref",
              "A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to."
            ),
          },
          additionalProperties: true,
        }),
      },
      optionalProperties: {
        calculated: makeObjectSchema("calculated", {
          requiredProperties: {
            score: makeNumberSchema(
              "score",
              `The score of the response, if the form has a score field`
            ),
          },
        }),
        variables: makeArraySchema(
          "variables",
          makeOneOf("variable", [
            makeObjectSchema("number variable", {
              requiredProperties: {
                key: makeStringSchema(
                  "key",
                  `The unique identifier for the variable`
                ),
                type: makeStringSchema("type", `The type of the variable`, {
                  const: "text",
                }),
                text: makeStringSchema("text", `The value of the variable`),
              },
            }),
            makeObjectSchema("number variable", {
              requiredProperties: {
                key: makeStringSchema(
                  "key",
                  `The unique identifier for the variable`
                ),
                type: makeStringSchema("type", `The type of the variable`, {
                  const: "number",
                }),
                number: makeNumberSchema("number", `The value of the variable`),
              },
            }),
          ])
        ),
        hidden: makeObjectSchema("hidden", {
          additionalProperties: true,
        }),
      },
    }),
  },
});
