export type AirtableFieldSet = {
  [key: string]:
    | undefined
    | string
    | number
    | boolean
    | Collaborator
    | Collaborator[]
    | string[]
    | Attachment[]
    | Formula;
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

export type FormulaError = {
  error: string;
};

export type FormulaSpecialValue = {
  specialValue: "Infinity" | "NaN";
};

export type Formula = string | number | FormulaError | FormulaSpecialValue;

export type Thumbnail = {
  url: string;
  width: number;
  height: number;
};

export type AirtableRecord<TFields extends AirtableFieldSet> = {
  id: string;
  fields: TFields;
  commentCount?: number;
};

export type CreateAirtableRecord<TFields extends AirtableFieldSet> = Pick<
  AirtableRecord<Partial<TFields>>,
  "fields"
>;
