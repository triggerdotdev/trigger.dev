
import { Airtable } from "airtable";
import { Prettify } from "@trigger.dev/integration-kit";

export type AirtableSDK = Airtable;

export type AirtableOptions = {
  id: string;
};

export type RecordParams = {
  table: string;
};

export type RecordResponse = Prettify<ReturnType<AirtableSDK['table']['select']['all']>>;
