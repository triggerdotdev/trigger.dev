export type AirtableTypes = (CreateRecordsInput | CreateRecordsOutput | DeleteRecordInput | DeleteRecordOutput | DeleteRecordsInput | DeleteRecordsOutput | GetRecordInput | GetRecordOutput | ListRecordsInput | ListRecordsOutput | UpdateRecordInput | UpdateRecordOutput | UpdateRecordsInput | UpdateRecordsOutput)
export type CreateRecordsInput = ({
  /**
   * The ID of the base
   */
  baseId: string
  /**
   * The name or id of the table
   */
  tableIdOrName: string
} & CreateRecordsBody)
/**
 * If set to true, Airtable will try to convert string values into the appropriate cell value. This conversion is only performed on a best-effort basis. To ensure your data's integrity, this should only be used when necessary. Defaults to false when unset.
 */
export type Typecast = boolean
export type FieldValue = (StringValue | NumberValue | BooleanValue | ACollaborator | Collaborators | StringValues | Attachments)
export type StringValue = string
export type NumberValue = number
export type BooleanValue = boolean
export type CollaboratorID = string
export type CollaboratorEmail = string
export type CollaboratorName = string
export type Collaborators = ACollaborator[]
export type StringValue1 = string
export type StringValues = StringValue1[]
export type AttachmentHeight = number
export type AttachmentWidth = number
export type ThumbnailURL = string
export type ThumbnailWidth = number
export type ThumbnailHeight = number
export type AttachmentID = string
export type AttachmentURL = string
export type AttachmentFilename = string
export type AttachmentSize = number
export type AttachmentType = string
export type Attachments = AnAttachment[]
export type RecordsToUpdateUpsert = Record[]
export type CreateRecordsOutput = (MultipleRecordsCreatedResponse | SingleRecordCreatedResponse)
export type RecordID = string
/**
 * A date timestamp in the ISO format, eg:"2018-01-01T00:00:00.000Z"
 */
export type CreatedTime = string
export type Records = Record1[]
export type RecordID1 = string
/**
 * A date timestamp in the ISO format, eg:"2018-01-01T00:00:00.000Z"
 */
export type CreatedTime1 = string
export type DeleteRecordInput = {
  /**
   * The ID of the base
   */
  baseId: string
  /**
   * The name or id of the table
   */
  tableIdOrName: string
  /**
   * The ID of the record
   */
  recordId: string
}
export type RecordID2 = string
/**
 * Whether the record was deleted
 */
export type Deleted = true
export type DeleteRecordsInput = {
  /**
   * The ID of the base
   */
  baseId: string
  /**
   * The name or id of the table
   */
  tableIdOrName: string
  records: RecordsToDelete
}
export type RecordID3 = string
/**
 * An array of record IDs to delete
 */
export type RecordsToDelete = RecordID3[]
export type RecordID4 = string
/**
 * Whether the record was deleted
 */
export type Deleted1 = true
export type Records1 = DeletedRecord[]
export type GetRecordInput = {
  /**
   * The ID of the base
   */
  baseId: string
  /**
   * The name or id of the table
   */
  tableIdOrName: string
  /**
   * The ID of the record
   */
  recordId: string
}
/**
 * When the record was created
 */
export type CreatedTime2 = string
/**
 * The record id
 */
export type Id = string
export type ListRecordsInput = ({
  /**
   * The ID of the base
   */
  baseId: string
  /**
   * The name or id of the table
   */
  tableIdOrName: string
} & ListRecordsBody)
/**
 * The time zone that should be used to format dates when using string as the cellFormat. This parameter is required when using string as the cellFormat
 */
export type Timezone = ("utc" | "client" | "Africa/Abidjan" | "Africa/Accra" | "Africa/Addis_Ababa" | "Africa/Algiers" | "Africa/Asmara" | "Africa/Bamako" | "Africa/Bangui" | "Africa/Banjul" | "Africa/Bissau" | "Africa/Blantyre" | "Africa/Brazzaville" | "Africa/Bujumbura" | "Africa/Cairo" | "Africa/Casablanca" | "Africa/Ceuta" | "Africa/Conakry" | "Africa/Dakar" | "Africa/Dar_es_Salaam" | "Africa/Djibouti" | "Africa/Douala" | "Africa/El_Aaiun" | "Africa/Freetown" | "Africa/Gaborone" | "Africa/Harare" | "Africa/Johannesburg" | "Africa/Juba" | "Africa/Kampala" | "Africa/Khartoum" | "Africa/Kigali" | "Africa/Kinshasa" | "Africa/Lagos" | "Africa/Libreville" | "Africa/Lome" | "Africa/Luanda" | "Africa/Lubumbashi" | "Africa/Lusaka" | "Africa/Malabo" | "Africa/Maputo" | "Africa/Maseru" | "Africa/Mbabane" | "Africa/Mogadishu" | "Africa/Monrovia" | "Africa/Nairobi" | "Africa/Ndjamena" | "Africa/Niamey" | "Africa/Nouakchott" | "Africa/Ouagadougou" | "Africa/Porto-Novo" | "Africa/Sao_Tome" | "Africa/Tripoli" | "Africa/Tunis" | "Africa/Windhoek" | "America/Adak" | "America/Anchorage" | "America/Anguilla" | "America/Antigua" | "America/Araguaina" | "America/Argentina/Buenos_Aires" | "America/Argentina/Catamarca" | "America/Argentina/Cordoba" | "America/Argentina/Jujuy" | "America/Argentina/La_Rioja" | "America/Argentina/Mendoza" | "America/Argentina/Rio_Gallegos" | "America/Argentina/Salta" | "America/Argentina/San_Juan" | "America/Argentina/San_Luis" | "America/Argentina/Tucuman" | "America/Argentina/Ushuaia" | "America/Aruba" | "America/Asuncion" | "America/Atikokan" | "America/Bahia" | "America/Bahia_Banderas" | "America/Barbados" | "America/Belem" | "America/Belize" | "America/Blanc-Sablon" | "America/Boa_Vista" | "America/Bogota" | "America/Boise" | "America/Cambridge_Bay" | "America/Campo_Grande" | "America/Cancun" | "America/Caracas" | "America/Cayenne" | "America/Cayman" | "America/Chicago" | "America/Chihuahua" | "America/Costa_Rica" | "America/Creston" | "America/Cuiaba" | "America/Curacao" | "America/Danmarkshavn" | "America/Dawson" | "America/Dawson_Creek" | "America/Denver" | "America/Detroit" | "America/Dominica" | "America/Edmonton" | "America/Eirunepe" | "America/El_Salvador" | "America/Fort_Nelson" | "America/Fortaleza" | "America/Glace_Bay" | "America/Godthab" | "America/Goose_Bay" | "America/Grand_Turk" | "America/Grenada" | "America/Guadeloupe" | "America/Guatemala" | "America/Guayaquil" | "America/Guyana" | "America/Halifax" | "America/Havana" | "America/Hermosillo" | "America/Indiana/Indianapolis" | "America/Indiana/Knox" | "America/Indiana/Marengo" | "America/Indiana/Petersburg" | "America/Indiana/Tell_City" | "America/Indiana/Vevay" | "America/Indiana/Vincennes" | "America/Indiana/Winamac" | "America/Inuvik" | "America/Iqaluit" | "America/Jamaica" | "America/Juneau" | "America/Kentucky/Louisville" | "America/Kentucky/Monticello" | "America/Kralendijk" | "America/La_Paz" | "America/Lima" | "America/Los_Angeles" | "America/Lower_Princes" | "America/Maceio" | "America/Managua" | "America/Manaus" | "America/Marigot" | "America/Martinique" | "America/Matamoros" | "America/Mazatlan" | "America/Menominee" | "America/Merida" | "America/Metlakatla" | "America/Mexico_City" | "America/Miquelon" | "America/Moncton" | "America/Monterrey" | "America/Montevideo" | "America/Montserrat" | "America/Nassau" | "America/New_York" | "America/Nipigon" | "America/Nome" | "America/Noronha" | "America/North_Dakota/Beulah" | "America/North_Dakota/Center" | "America/North_Dakota/New_Salem" | "America/Nuuk" | "America/Ojinaga" | "America/Panama" | "America/Pangnirtung" | "America/Paramaribo" | "America/Phoenix" | "America/Port-au-Prince" | "America/Port_of_Spain" | "America/Porto_Velho" | "America/Puerto_Rico" | "America/Punta_Arenas" | "America/Rainy_River" | "America/Rankin_Inlet" | "America/Recife" | "America/Regina" | "America/Resolute" | "America/Rio_Branco" | "America/Santarem" | "America/Santiago" | "America/Santo_Domingo" | "America/Sao_Paulo" | "America/Scoresbysund" | "America/Sitka" | "America/St_Barthelemy" | "America/St_Johns" | "America/St_Kitts" | "America/St_Lucia" | "America/St_Thomas" | "America/St_Vincent" | "America/Swift_Current" | "America/Tegucigalpa" | "America/Thule" | "America/Thunder_Bay" | "America/Tijuana" | "America/Toronto" | "America/Tortola" | "America/Vancouver" | "America/Whitehorse" | "America/Winnipeg" | "America/Yakutat" | "America/Yellowknife" | "Antarctica/Casey" | "Antarctica/Davis" | "Antarctica/DumontDUrville" | "Antarctica/Macquarie" | "Antarctica/Mawson" | "Antarctica/McMurdo" | "Antarctica/Palmer" | "Antarctica/Rothera" | "Antarctica/Syowa" | "Antarctica/Troll" | "Antarctica/Vostok" | "Arctic/Longyearbyen" | "Asia/Aden" | "Asia/Almaty" | "Asia/Amman" | "Asia/Anadyr" | "Asia/Aqtau" | "Asia/Aqtobe" | "Asia/Ashgabat" | "Asia/Atyrau" | "Asia/Baghdad" | "Asia/Bahrain" | "Asia/Baku" | "Asia/Bangkok" | "Asia/Barnaul" | "Asia/Beirut" | "Asia/Bishkek" | "Asia/Brunei" | "Asia/Chita" | "Asia/Choibalsan" | "Asia/Colombo" | "Asia/Damascus" | "Asia/Dhaka" | "Asia/Dili" | "Asia/Dubai" | "Asia/Dushanbe" | "Asia/Famagusta" | "Asia/Gaza" | "Asia/Hebron" | "Asia/Ho_Chi_Minh" | "Asia/Hong_Kong" | "Asia/Hovd" | "Asia/Irkutsk" | "Asia/Istanbul" | "Asia/Jakarta" | "Asia/Jayapura" | "Asia/Jerusalem" | "Asia/Kabul" | "Asia/Kamchatka" | "Asia/Karachi" | "Asia/Kathmandu" | "Asia/Khandyga" | "Asia/Kolkata" | "Asia/Krasnoyarsk" | "Asia/Kuala_Lumpur" | "Asia/Kuching" | "Asia/Kuwait" | "Asia/Macau" | "Asia/Magadan" | "Asia/Makassar" | "Asia/Manila" | "Asia/Muscat" | "Asia/Nicosia" | "Asia/Novokuznetsk" | "Asia/Novosibirsk" | "Asia/Omsk" | "Asia/Oral" | "Asia/Phnom_Penh" | "Asia/Pontianak" | "Asia/Pyongyang" | "Asia/Qatar" | "Asia/Qostanay" | "Asia/Qyzylorda" | "Asia/Rangoon" | "Asia/Riyadh" | "Asia/Sakhalin" | "Asia/Samarkand" | "Asia/Seoul" | "Asia/Shanghai" | "Asia/Singapore" | "Asia/Srednekolymsk" | "Asia/Taipei" | "Asia/Tashkent" | "Asia/Tbilisi" | "Asia/Tehran" | "Asia/Thimphu" | "Asia/Tokyo" | "Asia/Tomsk" | "Asia/Ulaanbaatar" | "Asia/Urumqi" | "Asia/Ust-Nera" | "Asia/Vientiane" | "Asia/Vladivostok" | "Asia/Yakutsk" | "Asia/Yangon" | "Asia/Yekaterinburg" | "Asia/Yerevan" | "Atlantic/Azores" | "Atlantic/Bermuda" | "Atlantic/Canary" | "Atlantic/Cape_Verde" | "Atlantic/Faroe" | "Atlantic/Madeira" | "Atlantic/Reykjavik" | "Atlantic/South_Georgia" | "Atlantic/St_Helena" | "Atlantic/Stanley" | "Australia/Adelaide" | "Australia/Brisbane" | "Australia/Broken_Hill" | "Australia/Currie" | "Australia/Darwin" | "Australia/Eucla" | "Australia/Hobart" | "Australia/Lindeman" | "Australia/Lord_Howe" | "Australia/Melbourne" | "Australia/Perth" | "Australia/Sydney" | "Europe/Amsterdam" | "Europe/Andorra" | "Europe/Astrakhan" | "Europe/Athens" | "Europe/Belgrade" | "Europe/Berlin" | "Europe/Bratislava" | "Europe/Brussels" | "Europe/Bucharest" | "Europe/Budapest" | "Europe/Busingen" | "Europe/Chisinau" | "Europe/Copenhagen" | "Europe/Dublin" | "Europe/Gibraltar" | "Europe/Guernsey" | "Europe/Helsinki" | "Europe/Isle_of_Man" | "Europe/Istanbul" | "Europe/Jersey" | "Europe/Kaliningrad" | "Europe/Kiev" | "Europe/Kirov" | "Europe/Lisbon" | "Europe/Ljubljana" | "Europe/London" | "Europe/Luxembourg" | "Europe/Madrid" | "Europe/Malta" | "Europe/Mariehamn" | "Europe/Minsk" | "Europe/Monaco" | "Europe/Moscow" | "Europe/Nicosia" | "Europe/Oslo" | "Europe/Paris" | "Europe/Podgorica" | "Europe/Prague" | "Europe/Riga" | "Europe/Rome" | "Europe/Samara" | "Europe/San_Marino" | "Europe/Sarajevo" | "Europe/Saratov" | "Europe/Simferopol" | "Europe/Skopje" | "Europe/Sofia" | "Europe/Stockholm" | "Europe/Tallinn" | "Europe/Tirane" | "Europe/Ulyanovsk" | "Europe/Uzhgorod" | "Europe/Vaduz" | "Europe/Vatican" | "Europe/Vienna" | "Europe/Vilnius" | "Europe/Volgograd" | "Europe/Warsaw" | "Europe/Zagreb" | "Europe/Zaporozhye" | "Europe/Zurich" | "Indian/Antananarivo" | "Indian/Chagos" | "Indian/Christmas" | "Indian/Cocos" | "Indian/Comoro" | "Indian/Kerguelen" | "Indian/Mahe" | "Indian/Maldives" | "Indian/Mauritius" | "Indian/Mayotte" | "Indian/Reunion" | "Pacific/Apia" | "Pacific/Auckland" | "Pacific/Bougainville" | "Pacific/Chatham" | "Pacific/Chuuk" | "Pacific/Easter" | "Pacific/Efate" | "Pacific/Enderbury" | "Pacific/Fakaofo" | "Pacific/Fiji" | "Pacific/Funafuti" | "Pacific/Galapagos" | "Pacific/Gambier" | "Pacific/Guadalcanal" | "Pacific/Guam" | "Pacific/Honolulu" | "Pacific/Kanton" | "Pacific/Kiritimati" | "Pacific/Kosrae" | "Pacific/Kwajalein" | "Pacific/Majuro" | "Pacific/Marquesas" | "Pacific/Midway" | "Pacific/Nauru" | "Pacific/Niue" | "Pacific/Norfolk" | "Pacific/Noumea" | "Pacific/Pago_Pago" | "Pacific/Palau" | "Pacific/Pitcairn" | "Pacific/Pohnpei" | "Pacific/Port_Moresby" | "Pacific/Rarotonga" | "Pacific/Saipan" | "Pacific/Tahiti" | "Pacific/Tarawa" | "Pacific/Tongatapu" | "Pacific/Wake" | "Pacific/Wallis")
/**
 * The user locale that should be used to format dates when using string as the cellFormat. This parameter is required when using string as the cellFormat.
 */
export type UserLocal = string
/**
 * The number of records returned in each request. Must be less than or equal to 100. Default is 100.
 */
export type PageSize = number
/**
 * The maximum total number of records that will be returned in your requests. If this value is larger than pageSize (which is 100 by default), you may have to load multiple pages to reach this total.
 */
export type MaxRecords = number
/**
 * To fetch the next page of records, include offset from the previous request in the next request's parameters.
 */
export type Offset = string
/**
 * The name or ID of a view in the table. If set, only the records in that view will be returned. The records will be sorted according to the order of the view unless the sort parameter is included, which overrides that order. Fields hidden in this view will be returned in the results. To only return a subset of fields, use the fields parameter.
 */
export type View = string
/**
 * Direction
 */
export type Direction = ("asc" | "desc")
export type FieldName = string
export type Sort = SortField[]
/**
 * A formula used to filter records. The formula will be evaluated for each record, and if the result is not 0, false, "", NaN, [], or #Error! the record will be included in the response. If combined with the view parameter, only records in that view which satisfy the formula will be returned. For example, to only include records where the column named "Category" equals "Programming", pass in: filterByFormula={Category}="Programming"
 */
export type FilterByFormula = string
export type FieldName1 = string
export type OnlyDataForFieldsWhoseNamesOrIDsAreInThisListWillBeIncludedInTheResultIfYouDonTNeedEveryFieldYouCanUseThisParameterToReduceTheAmountOfDataTransferred = FieldName1[]
/**
 * To fetch the next page of records, include offset from the previous request in the next request's parameters.
 */
export type Offset1 = string
export type Records2 = Record1[]
export type UpdateRecordInput = ({
  /**
   * The ID of the base
   */
  baseId: string
  /**
   * The name or id of the table
   */
  tableIdOrName: string
  /**
   * The ID of the record
   */
  recordId: string
} & UpdateRecordBody)
/**
 * If set to true, Airtable will try to convert string values into the appropriate cell value. This conversion is only performed on a best-effort basis. To ensure your data's integrity, this should only be used when necessary. Defaults to false when unset.
 */
export type Typecast1 = boolean
export type RecordID5 = string
/**
 * A date timestamp in the ISO format, eg:"2018-01-01T00:00:00.000Z"
 */
export type CreatedTime3 = string
export type UpdateRecordsInput = ({
  /**
   * The ID of the base
   */
  baseId: string
  /**
   * The name or id of the table
   */
  tableIdOrName: string
} & UpdateRecordsBody)
export type FieldName2 = string
export type FieldsToMergeOn = FieldName2[]
/**
 * If set to true, Airtable will try to convert string values into the appropriate cell value. This conversion is only performed on a best-effort basis. To ensure your data's integrity, this should only be used when necessary. Defaults to false when unset.
 */
export type Typecast2 = boolean
/**
 * Record ID. Required when performUpsert is not set.
 */
export type Id1 = string
export type RecordsToUpdateUpsert1 = Record2[]
export type UpdateRecordsOutput = (UpdateResponse | UpsertResponse)
export type Records3 = Record1[]
export type RecordID6 = string
export type CreatedRecords = RecordID6[]
export type RecordID7 = string
export type UpdatedRecords = RecordID7[]
export type Records4 = Record1[]

export interface CreateRecordsBody {
  typecast?: Typecast
  fields?: Fields
  records?: RecordsToUpdateUpsert
}
export interface Fields {
  [k: string]: FieldValue
}
export interface ACollaborator {
  id: CollaboratorID
  email: CollaboratorEmail
  name: CollaboratorName
  [k: string]: unknown
}
export interface AnAttachment {
  height?: AttachmentHeight
  width?: AttachmentWidth
  thumbnails?: Thumbnails
  id: AttachmentID
  url: AttachmentURL
  filename: AttachmentFilename
  size: AttachmentSize
  type: AttachmentType
  [k: string]: unknown
}
export interface Thumbnails {
  small: AThumbnail
  large: AThumbnail
  full: AThumbnail
  [k: string]: unknown
}
export interface AThumbnail {
  url: ThumbnailURL
  width: ThumbnailWidth
  height: ThumbnailHeight
  [k: string]: unknown
}
export interface Record {
  fields: Fields
}
export interface MultipleRecordsCreatedResponse {
  records: Records
}
export interface Record1 {
  id: RecordID
  createdTime: CreatedTime
  fields: Fields
}
export interface SingleRecordCreatedResponse {
  id: RecordID1
  createdTime: CreatedTime1
  fields: Fields
}
export interface DeleteRecordOutput {
  id: RecordID2
  deleted: Deleted
}
export interface DeleteRecordsOutput {
  records: Records1
}
export interface DeletedRecord {
  id: RecordID4
  deleted: Deleted1
}
export interface GetRecordOutput {
  createdTime: CreatedTime2
  fields: Fields
  id: Id
}
export interface ListRecordsBody {
  timeZone?: Timezone
  userLocal?: UserLocal
  pageSize?: PageSize
  maxRecords?: MaxRecords
  offset?: Offset
  view?: View
  sort?: Sort
  filterByFormula?: FilterByFormula
  fields?: OnlyDataForFieldsWhoseNamesOrIDsAreInThisListWillBeIncludedInTheResultIfYouDonTNeedEveryFieldYouCanUseThisParameterToReduceTheAmountOfDataTransferred
}
export interface SortField {
  direction?: Direction
  field: FieldName
}
export interface ListRecordsOutput {
  offset?: Offset1
  records: Records2
}
export interface UpdateRecordBody {
  typecast?: Typecast1
  fields: Fields
}
export interface UpdateRecordOutput {
  id: RecordID5
  createdTime: CreatedTime3
  fields: Fields
}
export interface UpdateRecordsBody {
  performUpsert?: PerformUpsert
  typecast?: Typecast2
  records: RecordsToUpdateUpsert1
}
export interface PerformUpsert {
  fieldsToMergeOn: FieldsToMergeOn
}
export interface Record2 {
  id?: Id1
  fields: Fields
}
export interface UpdateResponse {
  records: Records3
}
export interface UpsertResponse {
  createdRecords: CreatedRecords
  updatedRecords: UpdatedRecords
  records: Records4
}

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
