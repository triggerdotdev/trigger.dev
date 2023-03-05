export type TypeformTypes = (FormResponseInput | FormResponseOutput)
export type FormID = string
/**
 * The ID of the event that triggered this webhook
 */
export type EventId = string
/**
 * The type of event, always "form_response"
 */
export type EventType = "form_response"
/**
 * The score of the response, if the form has a score field
 */
export type Score = number
export type Variable = (NumberVariable | NumberVariable1)
/**
 * The ID of the variable
 */
export type Id = string
/**
 * The type of the variable
 */
export type Type = "text"
/**
 * The value of the variable
 */
export type Text = string
/**
 * The ID of the variable
 */
export type Id1 = string
/**
 * The type of the variable
 */
export type Type1 = "number"
/**
 * The value of the variable
 */
export type Number = number
export type Variables = Variable[]
/**
 * The ID of the form that was submitted
 */
export type FormId = string
/**
 * The unique token for this response
 */
export type Token = string
/**
 * The date and time the response was submitted
 */
export type SubmittedAt = string
/**
 * The date and time the respondent landed on the form
 */
export type LandedAt = string
/**
 * The ID of the ending
 */
export type Id2 = string
/**
 * A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to.
 */
export type Ref = string
/**
 * The title of the ending
 */
export type Title = string
/**
 * The type of the ending
 */
export type Type2 = string
export type Endings = Ending[]
/**
 * The ID of the form
 */
export type Id3 = string
/**
 * The title of the form
 */
export type Title1 = string
/**
 * The ID of the field
 */
export type Id4 = string
/**
 * The title of the field
 */
export type Title2 = string
/**
 * The type of the field
 */
export type Type3 = string
/**
 * A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to.
 */
export type Ref1 = string
/**
 * Whether or not the field allows multiple selections
 */
export type AllowMultipleSelectiors = boolean
/**
 * Whether or not the field allows an 'other' choice
 */
export type AllowOtherChoice = boolean
/**
 * The label of the choice
 */
export type Label = string
/**
 * The ID of the choice
 */
export type Id5 = string
export type Choices = Choice[]
export type Fields = Field[]
export type Answer = [{ "type": "object", "title": "text answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "text" }, "text": { "type": "string", "title": "text", "description": "The value of the answer" }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "enum": ["short_text", "long_text"] } }, "required": ["id", "type"] } }, "required": ["type", "text", "field"] }, { "type": "object", "title": "choice answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "choice" }, "choice": { "type": "object", "title": "choice", "properties": { "label": { "type": "string", "title": "label", "description": "The label of the choice" }, "other": { "type": "string", "title": "label", "description": "What the user typed in to the \"other\" field" } } }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "enum": ["picture_choice", "dropdown", "multiple_choice"] } }, "required": ["id", "type"] } }, "required": ["type", "choice", "field"] }, { "type": "object", "title": "choices answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "choices" }, "choices": { "type": "object", "title": "choices", "properties": { "other": { "type": "string", "title": "label", "description": "What the user typed in to the \"other\" field" }, "labels": { "type": "array", "title": "labels", "items": { "type": "string", "title": "label", "description": "The label of the choice" } } }, "required": ["labels"] }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "enum": ["picture_choice", "dropdown", "multiple_choice"] } }, "required": ["id", "type"] } }, "required": ["type", "choices", "field"] }, { "type": "object", "title": "email answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "email" }, "email": { "type": "string", "title": "email", "description": "The value of the answer" }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "const": "email" } }, "required": ["id", "type"] } }, "required": ["type", "email", "field"] }, { "type": "object", "title": "date answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "date" }, "date": { "type": "string", "title": "date", "description": "The value of the answer" }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "const": "date" } }, "required": ["id", "type"] } }, "required": ["type", "date", "field"] }, { "type": "object", "title": "boolean answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "boolean" }, "boolean": { "title": "boolean", "type": "boolean", "description": "The value of the answer" }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "enum": ["legal", "yes_no"] } }, "required": ["id", "type"] } }, "required": ["type", "boolean", "field"] }, { "type": "object", "title": "url answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "url" }, "url": { "type": "string", "title": "url", "description": "The value of the answer" }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "enum": ["website", "calendly"] } }, "required": ["id", "type"] } }, "required": ["type", "url", "field"] }, { "type": "object", "title": "number answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "number" }, "number": { "type": "number", "title": "number", "description": "The value of the answer" }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "enum": ["rating", "opinion_scale", "number"] } }, "required": ["id", "type"] } }, "required": ["type", "number", "field"] }, { "type": "object", "title": "file url answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "file_url" }, "file_url": { "type": "string", "title": "file_url", "description": "The value of the answer" }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "const": "file_upload" } }, "required": ["id", "type"] } }, "required": ["type", "file_url", "field"] }, { "type": "object", "title": "payment answer", "properties": { "type": { "type": "string", "title": "type", "description": "The type of the answer", "const": "payment" }, "payment": { "type": "object", "title": "payment", "properties": { "amount": { "type": "number", "title": "amount", "description": "The amount of the payment" }, "last4": { "type": "string", "title": "last4", "description": "The last 4 digits of the card" }, "name": { "type": "string", "title": "name", "description": "The name of the credit card" }, "success": { "title": "success", "type": "boolean", "description": "Whether the payment succeeded" } }, "required": ["amount", "last4", "name", "success"] }, "field": { "type": "object", "title": "field", "properties": { "ref": { "type": "string", "title": "ref", "description": "The ref of the field" }, "id": { "type": "string", "title": "id", "description": "The ID of the field" }, "type": { "type": "string", "title": "type", "description": "The type of the field", "const": "payment" } }, "required": ["id", "type"] } }, "required": ["type", "payment", "field"] }]
export type Answers = Answer[]
/**
 * The ID of the ending
 */
export type Id6 = string
/**
 * A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to.
 */
export type Ref2 = string

export interface FormResponseInput {
  form_id: FormID
}
export interface FormResponseOutput {
  event_id: EventId
  event_type: EventType
  form_response: FormResponse
}
export interface FormResponse {
  calculated?: Calculated
  variables?: Variables
  hidden?: Hidden
  form_id: FormId
  token: Token
  submitted_at: SubmittedAt
  landed_at: LandedAt
  definition: Definition
  answers: Answers
  ending: Ending1
}
export interface Calculated {
  score: Score
}
export interface NumberVariable {
  id: Id
  type: Type
  text: Text
}
export interface NumberVariable1 {
  id: Id1
  type: Type1
  number: Number
}
export interface Hidden {
  [k: string]: unknown
}
export interface Definition {
  endings?: Endings
  id: Id3
  title: Title1
  fields: Fields
}
export interface Ending {
  id: Id2
  ref: Ref
  title: Title
  type: Type2
  [k: string]: unknown
}
export interface Field {
  id: Id4
  title: Title2
  type: Type3
  ref: Ref1
  allow_multiple_selectiors: AllowMultipleSelectiors
  allow_other_choice: AllowOtherChoice
  choices: Choices
}
export interface Choice {
  label: Label
  id: Id5
}
export interface Ending1 {
  id: Id6
  ref: Ref2
  [k: string]: unknown
}

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
