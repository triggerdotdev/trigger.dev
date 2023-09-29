import { Prettify } from "@trigger.dev/integration-kit";
import { Typeform, createClient } from "@typeform/api-client";

export type TypeformIntegrationOptions = {
  id: string;
  token?: string;
  apiBaseUrl?: string;
};

export type TypeformSDK = ReturnType<typeof createClient>;

export type ListFormsParams = {
  page?: number;
  pageSize?: number;
  search?: string;
  workspaceId?: string;
} | void;

export type ListFormsResponse = Prettify<Typeform.API.Forms.List>;

export type ListResponsesParams = {
  uid: string;
  pageSize?: number;
  since?: string;
  until?: string;
  after?: string;
  before?: string;
  ids?: string | string[];
  completed?: boolean;
  sort?: string;
  query?: string;
  fields?: string | string[];
};

//fix because the Typeform SDK doesn't have the `token` property on an item…
type ResponseListItem = Prettify<Typeform.API.Responses.List["items"][number]> & {
  token?: string;
};

export type ListResponsesResponse = Prettify<
  Omit<Typeform.API.Responses.List, "items"> & { items: ResponseListItem[] }
>;

export type GetFormParams = {
  uid: string;
};

export type GetFormResponse = Prettify<Typeform.Form>;

export type GetAllResponsesParams = Prettify<Omit<ListResponsesParams, "pageSize">>;

export type GetAllResponsesResponse = Prettify<Typeform.API.Responses.List["items"]>;

export type GetWebhookResponse = Prettify<Typeform.Webhook>;

export type ListWebhooksParams = {
  uid: string;
};

export type ListWebhooksResponse = Prettify<Typeform.API.Webhooks.List>;

export type CreateWebhookParams = {
  uid: string;
  tag: string;
  url: string;
  enabled?: boolean;
  secret?: string;
  verifySSL?: boolean;
};

export type UpdateWebhookParams = {
  uid: string;
  tag: string;
  url: string;
  enabled?: boolean;
  secret?: string;
  verifySSL?: boolean;
};

export type GetWebhookParams = {
  uid: string;
  tag: string;
};

export type DeleteWebhookParams = {
  uid: string;
  tag: string;
};

export type DeleteWebhookResponse = null;

export type FormResponseEvent = {
  event_id: string;
  event_type: "form_response";
  form_response: {
    form_id: string;
    token: string;
    landed_at: string;
    submitted_at: string;
    calculated: {
      score: number;
    };
    variables: Array<
      | {
          key: string;
          type: "number";
          number: number;
        }
      | {
          key: string;
          type: "text";
          text: string;
        }
    >;
    hidden: Record<string, string>;
    definition: {
      id: string;
      title: string;
      fields: Array<{
        id: string;
        ref: string;
        type: string;
        title: string;
        allow_multiple_selections?: boolean;
        allow_other_choice?: boolean;
        properties?: Record<string, string | boolean | number>;
        choices?: Array<{
          id: string;
          label: string;
        }>;
      }>;
      ending: {
        id: string;
        title: string;
        ref: string;
        type: string;
        properties?: Record<string, string | boolean | number>;
      };
    };
    answers: Array<FormResponseAnswer>;
    ending: {
      id: string;
      ref: string;
    };
  };
};

type FormResponseAnswerBase = {
  field: {
    id: string;
    type: string;
    ref: string;
  };
};
type FormResponseAnswerEmail = Prettify<
  FormResponseAnswerBase & {
    type: "email";
    email: string;
  }
>;

type FormResponseAnswerText = Prettify<
  FormResponseAnswerBase & {
    type: "text";
    text: string;
  }
>;

type FormResponseAnswerNumber = Prettify<
  FormResponseAnswerBase & {
    type: "number";
    number: number;
  }
>;

type FormResponseAnswerBoolean = Prettify<
  FormResponseAnswerBase & {
    type: "boolean";
    boolean: boolean;
  }
>;

type FormResponseAnswerDate = Prettify<
  FormResponseAnswerBase & {
    type: "date";
    date: string;
  }
>;

type FormResponseAnswerChoice = Prettify<
  FormResponseAnswerBase & {
    type: "choice";
    choice: {
      label: string;
    };
  }
>;

type FormResponseAnswer = Prettify<
  | FormResponseAnswerEmail
  | FormResponseAnswerText
  | FormResponseAnswerNumber
  | FormResponseAnswerBoolean
  | FormResponseAnswerDate
  | FormResponseAnswerChoice
>;
