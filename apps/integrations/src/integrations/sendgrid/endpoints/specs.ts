import { EndpointSpec, EndpointSpecResponse } from "core/endpoint/types";

const defaultResponses: EndpointSpecResponse[] = [
  {
    matches: ({ statusCode, body }) =>
      (statusCode < 200 || statusCode >= 300) && body != null,
    success: false,
    name: "Error",
    description: "error response",
    schema: "#/definitions/error_response_body",
  },
  {
    matches: ({ statusCode }) => statusCode < 200 || statusCode >= 300,
    success: false,
    name: "Error",
    description: "No body error response",
    schema: undefined,
  },
];

export const mailSend: EndpointSpec = {
  path: "/mail/send",
  method: "POST",
  metadata: {
    name: "mailSend",
    description: "Send email to one or more recipients with personalization",
    displayProperties: {
      title: "Send mail",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://docs.sendgrid.com/api-reference/mail-send/mail-send",
    },
    tags: ["send"],
  },
  security: {
    api_key: ["mail.send"],
  },
  request: {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: {
      schema: "#/definitions/mail_send_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Successful response",
      schema: undefined,
    },
    ...defaultResponses,
  ],
};

export const marketingContacts: EndpointSpec = {
  path: "/marketing/contacts",
  method: "PUT",
  metadata: {
    name: "marketingContacts",
    description:
      "Add or update (up to 30k) contacts. Contacts are queued and aren't created immediately.",
    displayProperties: {
      title: "Add/update contacts",
    },
    externalDocs: {
      description: "API method documentation",
      url: "https://docs.sendgrid.com/api-reference/contacts/add-or-update-a-contact",
    },
    tags: ["contacts"],
  },
  security: {
    api_key: [],
  },
  request: {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: {
      schema: "#/definitions/marketing_contacts_request_body",
    },
  },
  responses: [
    {
      matches: ({ statusCode }) => statusCode >= 200 && statusCode < 300,
      success: true,
      name: "Success",
      description: "Successful response",
      schema: "#/definitions/marketing_contacts_response_body",
    },
    ...defaultResponses,
  ],
};
