import { Prettify } from "@trigger.dev/integration-kit";

export type AirtableFieldSet = {
  [key: string]:
    | undefined
    | string
    | number
    | boolean
    | Collaborator
    | Collaborator[]
    | string[]
    | Attachment[];
};

export type Collaborator = {
  id: string;
  email: string;
  name: string;
};

export type Attachment = {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string;
  thumbnails?: {
    small: Thumbnail;
    large: Thumbnail;
    full: Thumbnail;
  };
};

export type Thumbnail = {
  url: string;
  width: number;
  height: number;
};
