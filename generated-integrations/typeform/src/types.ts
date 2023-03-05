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
 * The unique identifier for the variable
 */
export type Key = string
/**
 * The type of the variable
 */
export type Type = "text"
/**
 * The value of the variable
 */
export type Text = string
/**
 * The unique identifier for the variable
 */
export type Key1 = string
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
export type Id = string
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
export type Id1 = string
/**
 * The title of the form
 */
export type Title1 = string
/**
 * Whether or not the field allows multiple selections
 */
export type AllowMultipleSelections = boolean
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
export type Id2 = string
export type Choices = Choice[]
/**
 * The ID of the field
 */
export type Id3 = string
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
export type Fields = Field[]
export type Answer = (TextAnswer | ChoiceAnswer | ChoicesAnswer | EmailAnswer | DateAnswer | BooleanAnswer | UrlAnswer | NumberAnswer | FileUrlAnswer | PaymentAnswer)
/**
 * The type of the answer
 */
export type Type4 = "text"
/**
 * The value of the answer
 */
export type Text1 = string
/**
 * The ref of the field
 */
export type Ref2 = string
/**
 * The ID of the field
 */
export type Id4 = string
/**
 * The type of the field
 */
export type Type5 = ("short_text" | "long_text")
/**
 * The type of the answer
 */
export type Type6 = "choice"
/**
 * The label of the choice
 */
export type Label1 = string
/**
 * What the user typed in to the "other" field
 */
export type Label2 = string
/**
 * The ref of the field
 */
export type Ref3 = string
/**
 * The ID of the field
 */
export type Id5 = string
/**
 * The type of the field
 */
export type Type7 = ("picture_choice" | "dropdown" | "multiple_choice")
/**
 * The type of the answer
 */
export type Type8 = "choices"
/**
 * What the user typed in to the "other" field
 */
export type Label3 = string
/**
 * The label of the choice
 */
export type Label4 = string
export type Labels = Label4[]
/**
 * The ref of the field
 */
export type Ref4 = string
/**
 * The ID of the field
 */
export type Id6 = string
/**
 * The type of the field
 */
export type Type9 = ("picture_choice" | "dropdown" | "multiple_choice")
/**
 * The type of the answer
 */
export type Type10 = "email"
/**
 * The value of the answer
 */
export type Email = string
/**
 * The ref of the field
 */
export type Ref5 = string
/**
 * The ID of the field
 */
export type Id7 = string
/**
 * The type of the field
 */
export type Type11 = "email"
/**
 * The type of the answer
 */
export type Type12 = "date"
/**
 * The value of the answer
 */
export type Date = string
/**
 * The ref of the field
 */
export type Ref6 = string
/**
 * The ID of the field
 */
export type Id8 = string
/**
 * The type of the field
 */
export type Type13 = "date"
/**
 * The type of the answer
 */
export type Type14 = "boolean"
/**
 * The value of the answer
 */
export type Boolean = boolean
/**
 * The ref of the field
 */
export type Ref7 = string
/**
 * The ID of the field
 */
export type Id9 = string
/**
 * The type of the field
 */
export type Type15 = ("legal" | "yes_no")
/**
 * The type of the answer
 */
export type Type16 = "url"
/**
 * The value of the answer
 */
export type Url = string
/**
 * The ref of the field
 */
export type Ref8 = string
/**
 * The ID of the field
 */
export type Id10 = string
/**
 * The type of the field
 */
export type Type17 = ("website" | "calendly")
/**
 * The type of the answer
 */
export type Type18 = "number"
/**
 * The value of the answer
 */
export type Number1 = number
/**
 * The ref of the field
 */
export type Ref9 = string
/**
 * The ID of the field
 */
export type Id11 = string
/**
 * The type of the field
 */
export type Type19 = string
/**
 * The type of the answer
 */
export type Type20 = "file_url"
/**
 * The value of the answer
 */
export type FileUrl = string
/**
 * The ref of the field
 */
export type Ref10 = string
/**
 * The ID of the field
 */
export type Id12 = string
/**
 * The type of the field
 */
export type Type21 = "file_upload"
/**
 * The type of the answer
 */
export type Type22 = "payment"
/**
 * The amount of the payment
 */
export type Amount = number
/**
 * The last 4 digits of the card
 */
export type Last4 = string
/**
 * The name of the credit card
 */
export type Name = string
/**
 * Whether the payment succeeded
 */
export type Success = boolean
/**
 * The ref of the field
 */
export type Ref11 = string
/**
 * The ID of the field
 */
export type Id13 = string
/**
 * The type of the field
 */
export type Type23 = "payment"
export type Answers = Answer[]
/**
 * The ID of the ending
 */
export type Id14 = string
/**
 * A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to.
 */
export type Ref12 = string

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
  key: Key
  type: Type
  text: Text
}
export interface NumberVariable1 {
  key: Key1
  type: Type1
  number: Number
}
export interface Hidden {
  [k: string]: unknown
}
export interface Definition {
  endings?: Endings
  id: Id1
  title: Title1
  fields: Fields
}
export interface Ending {
  id: Id
  ref: Ref
  title: Title
  type: Type2
  [k: string]: unknown
}
export interface Field {
  allow_multiple_selections?: AllowMultipleSelections
  allow_other_choice?: AllowOtherChoice
  choices?: Choices
  id: Id3
  title: Title2
  type: Type3
  ref: Ref1
}
export interface Choice {
  label: Label
  id: Id2
}
export interface TextAnswer {
  type: Type4
  text: Text1
  field: Field1
}
export interface Field1 {
  ref?: Ref2
  id: Id4
  type: Type5
}
export interface ChoiceAnswer {
  type: Type6
  choice: Choice1
  field: Field2
}
export interface Choice1 {
  label?: Label1
  other?: Label2
}
export interface Field2 {
  ref?: Ref3
  id: Id5
  type: Type7
}
export interface ChoicesAnswer {
  type: Type8
  choices: Choices1
  field: Field3
}
export interface Choices1 {
  other?: Label3
  labels: Labels
}
export interface Field3 {
  ref?: Ref4
  id: Id6
  type: Type9
}
export interface EmailAnswer {
  type: Type10
  email: Email
  field: Field4
}
export interface Field4 {
  ref?: Ref5
  id: Id7
  type: Type11
}
export interface DateAnswer {
  type: Type12
  date: Date
  field: Field5
}
export interface Field5 {
  ref?: Ref6
  id: Id8
  type: Type13
}
export interface BooleanAnswer {
  type: Type14
  boolean: Boolean
  field: Field6
}
export interface Field6 {
  ref?: Ref7
  id: Id9
  type: Type15
}
export interface UrlAnswer {
  type: Type16
  url: Url
  field: Field7
}
export interface Field7 {
  ref?: Ref8
  id: Id10
  type: Type17
}
export interface NumberAnswer {
  type: Type18
  number: Number1
  field: Field8
}
export interface Field8 {
  ref?: Ref9
  id: Id11
  type: Type19
}
export interface FileUrlAnswer {
  type: Type20
  file_url: FileUrl
  field: Field9
}
export interface Field9 {
  ref?: Ref10
  id: Id12
  type: Type21
}
export interface PaymentAnswer {
  type: Type22
  payment: Payment
  field: Field10
}
export interface Payment {
  amount: Amount
  last4: Last4
  name: Name
  success: Success
}
export interface Field10 {
  ref?: Ref11
  id: Id13
  type: Type23
}
export interface Ending1 {
  id: Id14
  ref: Ref12
  [k: string]: unknown
}

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
