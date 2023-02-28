export type NotionTypes = (AppendBlockChildrenInput | AppendBlockChildrenOutput | CreateCommentInput | CreateCommentOutput | CreateDatabaseInput | CreateDatabaseOutput | CreatePageInput | CreatePageOutput | DeleteBlockInput | DeleteBlockOutput | GetBlockInput | GetBlockOutput | GetBlockChildrenInput | GetBlockChildrenOutput | GetBotInfoOutput | GetCommentsInput | GetCommentsOutput | GetDatabaseInput | GetDatabaseOutput | GetPageInput | GetPageOutput | GetUserInput | GetUserOutput5 | ListUsersInput | ListUsersOutput | QueryDatabaseInput | QueryDatabaseOutput | SearchInput | SearchOutput | UpdateBlockInput | UpdateBlockOutput | UpdateDatabaseInput | UpdateDatabaseOutput | UpdatePageInput | UpdatePageOutput)
export type AppendBlockChildrenInput = (Item & {
  children: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items17 | Items18 | Items43 | Items44 | Items45 | Items46 | Items47 | Items48 | Items49 | Items50 | Items51 | Items52 | Items53 | Items54 | Items55)[]
})
export type Color = ("default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red" | "gray_background" | "brown_background" | "orange_background" | "yellow_background" | "green_background" | "blue_background" | "purple_background" | "pink_background" | "red_background")
export type TimeZone = ("Africa/Abidjan" | "Africa/Accra" | "Africa/Addis_Ababa" | "Africa/Algiers" | "Africa/Asmara" | "Africa/Asmera" | "Africa/Bamako" | "Africa/Bangui" | "Africa/Banjul" | "Africa/Bissau" | "Africa/Blantyre" | "Africa/Brazzaville" | "Africa/Bujumbura" | "Africa/Cairo" | "Africa/Casablanca" | "Africa/Ceuta" | "Africa/Conakry" | "Africa/Dakar" | "Africa/Dar_es_Salaam" | "Africa/Djibouti" | "Africa/Douala" | "Africa/El_Aaiun" | "Africa/Freetown" | "Africa/Gaborone" | "Africa/Harare" | "Africa/Johannesburg" | "Africa/Juba" | "Africa/Kampala" | "Africa/Khartoum" | "Africa/Kigali" | "Africa/Kinshasa" | "Africa/Lagos" | "Africa/Libreville" | "Africa/Lome" | "Africa/Luanda" | "Africa/Lubumbashi" | "Africa/Lusaka" | "Africa/Malabo" | "Africa/Maputo" | "Africa/Maseru" | "Africa/Mbabane" | "Africa/Mogadishu" | "Africa/Monrovia" | "Africa/Nairobi" | "Africa/Ndjamena" | "Africa/Niamey" | "Africa/Nouakchott" | "Africa/Ouagadougou" | "Africa/Porto-Novo" | "Africa/Sao_Tome" | "Africa/Timbuktu" | "Africa/Tripoli" | "Africa/Tunis" | "Africa/Windhoek" | "America/Adak" | "America/Anchorage" | "America/Anguilla" | "America/Antigua" | "America/Araguaina" | "America/Argentina/Buenos_Aires" | "America/Argentina/Catamarca" | "America/Argentina/ComodRivadavia" | "America/Argentina/Cordoba" | "America/Argentina/Jujuy" | "America/Argentina/La_Rioja" | "America/Argentina/Mendoza" | "America/Argentina/Rio_Gallegos" | "America/Argentina/Salta" | "America/Argentina/San_Juan" | "America/Argentina/San_Luis" | "America/Argentina/Tucuman" | "America/Argentina/Ushuaia" | "America/Aruba" | "America/Asuncion" | "America/Atikokan" | "America/Atka" | "America/Bahia" | "America/Bahia_Banderas" | "America/Barbados" | "America/Belem" | "America/Belize" | "America/Blanc-Sablon" | "America/Boa_Vista" | "America/Bogota" | "America/Boise" | "America/Buenos_Aires" | "America/Cambridge_Bay" | "America/Campo_Grande" | "America/Cancun" | "America/Caracas" | "America/Catamarca" | "America/Cayenne" | "America/Cayman" | "America/Chicago" | "America/Chihuahua" | "America/Coral_Harbour" | "America/Cordoba" | "America/Costa_Rica" | "America/Creston" | "America/Cuiaba" | "America/Curacao" | "America/Danmarkshavn" | "America/Dawson" | "America/Dawson_Creek" | "America/Denver" | "America/Detroit" | "America/Dominica" | "America/Edmonton" | "America/Eirunepe" | "America/El_Salvador" | "America/Ensenada" | "America/Fort_Nelson" | "America/Fort_Wayne" | "America/Fortaleza" | "America/Glace_Bay" | "America/Godthab" | "America/Goose_Bay" | "America/Grand_Turk" | "America/Grenada" | "America/Guadeloupe" | "America/Guatemala" | "America/Guayaquil" | "America/Guyana" | "America/Halifax" | "America/Havana" | "America/Hermosillo" | "America/Indiana/Indianapolis" | "America/Indiana/Knox" | "America/Indiana/Marengo" | "America/Indiana/Petersburg" | "America/Indiana/Tell_City" | "America/Indiana/Vevay" | "America/Indiana/Vincennes" | "America/Indiana/Winamac" | "America/Indianapolis" | "America/Inuvik" | "America/Iqaluit" | "America/Jamaica" | "America/Jujuy" | "America/Juneau" | "America/Kentucky/Louisville" | "America/Kentucky/Monticello" | "America/Knox_IN" | "America/Kralendijk" | "America/La_Paz" | "America/Lima" | "America/Los_Angeles" | "America/Louisville" | "America/Lower_Princes" | "America/Maceio" | "America/Managua" | "America/Manaus" | "America/Marigot" | "America/Martinique" | "America/Matamoros" | "America/Mazatlan" | "America/Mendoza" | "America/Menominee" | "America/Merida" | "America/Metlakatla" | "America/Mexico_City" | "America/Miquelon" | "America/Moncton" | "America/Monterrey" | "America/Montevideo" | "America/Montreal" | "America/Montserrat" | "America/Nassau" | "America/New_York" | "America/Nipigon" | "America/Nome" | "America/Noronha" | "America/North_Dakota/Beulah" | "America/North_Dakota/Center" | "America/North_Dakota/New_Salem" | "America/Ojinaga" | "America/Panama" | "America/Pangnirtung" | "America/Paramaribo" | "America/Phoenix" | "America/Port-au-Prince" | "America/Port_of_Spain" | "America/Porto_Acre" | "America/Porto_Velho" | "America/Puerto_Rico" | "America/Punta_Arenas" | "America/Rainy_River" | "America/Rankin_Inlet" | "America/Recife" | "America/Regina" | "America/Resolute" | "America/Rio_Branco" | "America/Rosario" | "America/Santa_Isabel" | "America/Santarem" | "America/Santiago" | "America/Santo_Domingo" | "America/Sao_Paulo" | "America/Scoresbysund" | "America/Shiprock" | "America/Sitka" | "America/St_Barthelemy" | "America/St_Johns" | "America/St_Kitts" | "America/St_Lucia" | "America/St_Thomas" | "America/St_Vincent" | "America/Swift_Current" | "America/Tegucigalpa" | "America/Thule" | "America/Thunder_Bay" | "America/Tijuana" | "America/Toronto" | "America/Tortola" | "America/Vancouver" | "America/Virgin" | "America/Whitehorse" | "America/Winnipeg" | "America/Yakutat" | "America/Yellowknife" | "Antarctica/Casey" | "Antarctica/Davis" | "Antarctica/DumontDUrville" | "Antarctica/Macquarie" | "Antarctica/Mawson" | "Antarctica/McMurdo" | "Antarctica/Palmer" | "Antarctica/Rothera" | "Antarctica/South_Pole" | "Antarctica/Syowa" | "Antarctica/Troll" | "Antarctica/Vostok" | "Arctic/Longyearbyen" | "Asia/Aden" | "Asia/Almaty" | "Asia/Amman" | "Asia/Anadyr" | "Asia/Aqtau" | "Asia/Aqtobe" | "Asia/Ashgabat" | "Asia/Ashkhabad" | "Asia/Atyrau" | "Asia/Baghdad" | "Asia/Bahrain" | "Asia/Baku" | "Asia/Bangkok" | "Asia/Barnaul" | "Asia/Beirut" | "Asia/Bishkek" | "Asia/Brunei" | "Asia/Calcutta" | "Asia/Chita" | "Asia/Choibalsan" | "Asia/Chongqing" | "Asia/Chungking" | "Asia/Colombo" | "Asia/Dacca" | "Asia/Damascus" | "Asia/Dhaka" | "Asia/Dili" | "Asia/Dubai" | "Asia/Dushanbe" | "Asia/Famagusta" | "Asia/Gaza" | "Asia/Harbin" | "Asia/Hebron" | "Asia/Ho_Chi_Minh" | "Asia/Hong_Kong" | "Asia/Hovd" | "Asia/Irkutsk" | "Asia/Istanbul" | "Asia/Jakarta" | "Asia/Jayapura" | "Asia/Jerusalem" | "Asia/Kabul" | "Asia/Kamchatka" | "Asia/Karachi" | "Asia/Kashgar" | "Asia/Kathmandu" | "Asia/Katmandu" | "Asia/Khandyga" | "Asia/Kolkata" | "Asia/Krasnoyarsk" | "Asia/Kuala_Lumpur" | "Asia/Kuching" | "Asia/Kuwait" | "Asia/Macao" | "Asia/Macau" | "Asia/Magadan" | "Asia/Makassar" | "Asia/Manila" | "Asia/Muscat" | "Asia/Nicosia" | "Asia/Novokuznetsk" | "Asia/Novosibirsk" | "Asia/Omsk" | "Asia/Oral" | "Asia/Phnom_Penh" | "Asia/Pontianak" | "Asia/Pyongyang" | "Asia/Qatar" | "Asia/Qostanay" | "Asia/Qyzylorda" | "Asia/Rangoon" | "Asia/Riyadh" | "Asia/Saigon" | "Asia/Sakhalin" | "Asia/Samarkand" | "Asia/Seoul" | "Asia/Shanghai" | "Asia/Singapore" | "Asia/Srednekolymsk" | "Asia/Taipei" | "Asia/Tashkent" | "Asia/Tbilisi" | "Asia/Tehran" | "Asia/Tel_Aviv" | "Asia/Thimbu" | "Asia/Thimphu" | "Asia/Tokyo" | "Asia/Tomsk" | "Asia/Ujung_Pandang" | "Asia/Ulaanbaatar" | "Asia/Ulan_Bator" | "Asia/Urumqi" | "Asia/Ust-Nera" | "Asia/Vientiane" | "Asia/Vladivostok" | "Asia/Yakutsk" | "Asia/Yangon" | "Asia/Yekaterinburg" | "Asia/Yerevan" | "Atlantic/Azores" | "Atlantic/Bermuda" | "Atlantic/Canary" | "Atlantic/Cape_Verde" | "Atlantic/Faeroe" | "Atlantic/Faroe" | "Atlantic/Jan_Mayen" | "Atlantic/Madeira" | "Atlantic/Reykjavik" | "Atlantic/South_Georgia" | "Atlantic/St_Helena" | "Atlantic/Stanley" | "Australia/ACT" | "Australia/Adelaide" | "Australia/Brisbane" | "Australia/Broken_Hill" | "Australia/Canberra" | "Australia/Currie" | "Australia/Darwin" | "Australia/Eucla" | "Australia/Hobart" | "Australia/LHI" | "Australia/Lindeman" | "Australia/Lord_Howe" | "Australia/Melbourne" | "Australia/NSW" | "Australia/North" | "Australia/Perth" | "Australia/Queensland" | "Australia/South" | "Australia/Sydney" | "Australia/Tasmania" | "Australia/Victoria" | "Australia/West" | "Australia/Yancowinna" | "Brazil/Acre" | "Brazil/DeNoronha" | "Brazil/East" | "Brazil/West" | "CET" | "CST6CDT" | "Canada/Atlantic" | "Canada/Central" | "Canada/Eastern" | "Canada/Mountain" | "Canada/Newfoundland" | "Canada/Pacific" | "Canada/Saskatchewan" | "Canada/Yukon" | "Chile/Continental" | "Chile/EasterIsland" | "Cuba" | "EET" | "EST" | "EST5EDT" | "Egypt" | "Eire" | "Etc/GMT" | "Etc/GMT+0" | "Etc/GMT+1" | "Etc/GMT+10" | "Etc/GMT+11" | "Etc/GMT+12" | "Etc/GMT+2" | "Etc/GMT+3" | "Etc/GMT+4" | "Etc/GMT+5" | "Etc/GMT+6" | "Etc/GMT+7" | "Etc/GMT+8" | "Etc/GMT+9" | "Etc/GMT-0" | "Etc/GMT-1" | "Etc/GMT-10" | "Etc/GMT-11" | "Etc/GMT-12" | "Etc/GMT-13" | "Etc/GMT-14" | "Etc/GMT-2" | "Etc/GMT-3" | "Etc/GMT-4" | "Etc/GMT-5" | "Etc/GMT-6" | "Etc/GMT-7" | "Etc/GMT-8" | "Etc/GMT-9" | "Etc/GMT0" | "Etc/Greenwich" | "Etc/UCT" | "Etc/UTC" | "Etc/Universal" | "Etc/Zulu" | "Europe/Amsterdam" | "Europe/Andorra" | "Europe/Astrakhan" | "Europe/Athens" | "Europe/Belfast" | "Europe/Belgrade" | "Europe/Berlin" | "Europe/Bratislava" | "Europe/Brussels" | "Europe/Bucharest" | "Europe/Budapest" | "Europe/Busingen" | "Europe/Chisinau" | "Europe/Copenhagen" | "Europe/Dublin" | "Europe/Gibraltar" | "Europe/Guernsey" | "Europe/Helsinki" | "Europe/Isle_of_Man" | "Europe/Istanbul" | "Europe/Jersey" | "Europe/Kaliningrad" | "Europe/Kiev" | "Europe/Kirov" | "Europe/Lisbon" | "Europe/Ljubljana" | "Europe/London" | "Europe/Luxembourg" | "Europe/Madrid" | "Europe/Malta" | "Europe/Mariehamn" | "Europe/Minsk" | "Europe/Monaco" | "Europe/Moscow" | "Europe/Nicosia" | "Europe/Oslo" | "Europe/Paris" | "Europe/Podgorica" | "Europe/Prague" | "Europe/Riga" | "Europe/Rome" | "Europe/Samara" | "Europe/San_Marino" | "Europe/Sarajevo" | "Europe/Saratov" | "Europe/Simferopol" | "Europe/Skopje" | "Europe/Sofia" | "Europe/Stockholm" | "Europe/Tallinn" | "Europe/Tirane" | "Europe/Tiraspol" | "Europe/Ulyanovsk" | "Europe/Uzhgorod" | "Europe/Vaduz" | "Europe/Vatican" | "Europe/Vienna" | "Europe/Vilnius" | "Europe/Volgograd" | "Europe/Warsaw" | "Europe/Zagreb" | "Europe/Zaporozhye" | "Europe/Zurich" | "GB" | "GB-Eire" | "GMT" | "GMT+0" | "GMT-0" | "GMT0" | "Greenwich" | "HST" | "Hongkong" | "Iceland" | "Indian/Antananarivo" | "Indian/Chagos" | "Indian/Christmas" | "Indian/Cocos" | "Indian/Comoro" | "Indian/Kerguelen" | "Indian/Mahe" | "Indian/Maldives" | "Indian/Mauritius" | "Indian/Mayotte" | "Indian/Reunion" | "Iran" | "Israel" | "Jamaica" | "Japan" | "Kwajalein" | "Libya" | "MET" | "MST" | "MST7MDT" | "Mexico/BajaNorte" | "Mexico/BajaSur" | "Mexico/General" | "NZ" | "NZ-CHAT" | "Navajo" | "PRC" | "PST8PDT" | "Pacific/Apia" | "Pacific/Auckland" | "Pacific/Bougainville" | "Pacific/Chatham" | "Pacific/Chuuk" | "Pacific/Easter" | "Pacific/Efate" | "Pacific/Enderbury" | "Pacific/Fakaofo" | "Pacific/Fiji" | "Pacific/Funafuti" | "Pacific/Galapagos" | "Pacific/Gambier" | "Pacific/Guadalcanal" | "Pacific/Guam" | "Pacific/Honolulu" | "Pacific/Johnston" | "Pacific/Kiritimati" | "Pacific/Kosrae" | "Pacific/Kwajalein" | "Pacific/Majuro" | "Pacific/Marquesas" | "Pacific/Midway" | "Pacific/Nauru" | "Pacific/Niue" | "Pacific/Norfolk" | "Pacific/Noumea" | "Pacific/Pago_Pago" | "Pacific/Palau" | "Pacific/Pitcairn" | "Pacific/Pohnpei" | "Pacific/Ponape" | "Pacific/Port_Moresby" | "Pacific/Rarotonga" | "Pacific/Saipan" | "Pacific/Samoa" | "Pacific/Tahiti" | "Pacific/Tarawa" | "Pacific/Tongatapu" | "Pacific/Truk" | "Pacific/Wake" | "Pacific/Wallis" | "Pacific/Yap" | "Poland" | "Portugal" | "ROC" | "ROK" | "Singapore" | "Turkey" | "UCT" | "US/Alaska" | "US/Aleutian" | "US/Arizona" | "US/Central" | "US/East-Indiana" | "US/Eastern" | "US/Hawaii" | "US/Indiana-Starke" | "US/Michigan" | "US/Mountain" | "US/Pacific" | "US/Pacific-New" | "US/Samoa" | "UTC" | "Universal" | "W-SU" | "WET" | "Zulu")
export type Language = ("abap" | "agda" | "arduino" | "assembly" | "bash" | "basic" | "bnf" | "c" | "c#" | "c++" | "clojure" | "coffeescript" | "coq" | "css" | "dart" | "dhall" | "diff" | "docker" | "ebnf" | "elixir" | "elm" | "erlang" | "f#" | "flow" | "fortran" | "gherkin" | "glsl" | "go" | "graphql" | "groovy" | "haskell" | "html" | "idris" | "java" | "javascript" | "json" | "julia" | "kotlin" | "latex" | "less" | "lisp" | "livescript" | "llvm ir" | "lua" | "makefile" | "markdown" | "markup" | "matlab" | "mathematica" | "mermaid" | "nix" | "objective-c" | "ocaml" | "pascal" | "perl" | "php" | "plain text" | "powershell" | "prolog" | "protobuf" | "purescript" | "python" | "r" | "racket" | "reason" | "ruby" | "rust" | "sass" | "scala" | "scheme" | "scss" | "shell" | "solidity" | "sql" | "swift" | "toml" | "typescript" | "vb.net" | "verilog" | "vhdl" | "visual basic" | "webassembly" | "xml" | "yaml" | "java/c/c++/c#")
export type GetUserOutput = (User4 | User5)
export type TemplateMentionDate = ("today" | "now")
export type CreateCommentInput = ({
  parent: LinkToPage
  rich_text: (Items1 | Items2 | Items3)[]
} | {
  discussion_id: string
  rich_text: (Items1 | Items2 | Items3)[]
})
export type CreateCommentOutput = ({
  object: "comment"
  id: string
  parent: (LinkToPage3 | SyncedFrom1)
  discussion_id: string
  rich_text: (Items56 | Items57 | Items58)[]
  created_by: User3
  created_time: string
  last_edited_time: string
} | {
  object: "comment"
  id: string
})
export type CreateDatabaseInput = {
  parent: LinkToPage
  properties: {
    [k: string]: ({
      number: {
        format?: Format
      }
      type?: "number"
    } | {
      formula: {
        expression?: string
      }
      type?: "formula"
    } | {
      select: {
        options?: {
          name: string
          color?: Color1
        }[]
      }
      type?: "select"
    } | {
      multi_select: {
        options?: {
          name: string
          color?: Color1
        }[]
      }
      type?: "multi_select"
    } | {
      status: Bot
      type?: "status"
    } | {
      relation: ({
        single_property: Bot
        database_id: string
        type?: "single_property"
      } | {
        dual_property: Bot
        database_id: string
        type?: "dual_property"
      })
      type?: "relation"
    } | {
      rollup: ({
        rollup_property_name: string
        relation_property_name: string
        function: Function
        rollup_property_id?: string
        relation_property_id?: string
      } | {
        rollup_property_name: string
        relation_property_id: string
        function: Function
        relation_property_name?: string
        rollup_property_id?: string
      } | {
        relation_property_name: string
        rollup_property_id: string
        function: Function
        rollup_property_name?: string
        relation_property_id?: string
      } | {
        rollup_property_id: string
        relation_property_id: string
        function: Function
        rollup_property_name?: string
        relation_property_name?: string
      })
      type?: "rollup"
    } | {
      title: Bot
      type?: "title"
    } | {
      rich_text: Bot
      type?: "rich_text"
    } | {
      url: Bot
      type?: "url"
    } | {
      people: Bot
      type?: "people"
    } | {
      files: Bot
      type?: "files"
    } | {
      email: Bot
      type?: "email"
    } | {
      phone_number: Bot
      type?: "phone_number"
    } | {
      date: Bot
      type?: "date"
    } | {
      checkbox: Bot
      type?: "checkbox"
    } | {
      created_by: Bot
      type?: "created_by"
    } | {
      created_time: Bot
      type?: "created_time"
    } | {
      last_edited_by: Bot
      type?: "last_edited_by"
    } | {
      last_edited_time: Bot
      type?: "last_edited_time"
    })
  }
  icon?: (Icon | null | Icon1)
  cover?: (Icon1 | null)
  title?: (Items1 | Items2 | Items3)[]
  description?: (Items1 | Items2 | Items3)[]
  is_inline?: boolean
}
export type Format = ("number" | "number_with_commas" | "percent" | "dollar" | "canadian_dollar" | "singapore_dollar" | "euro" | "pound" | "yen" | "ruble" | "rupee" | "won" | "yuan" | "real" | "lira" | "rupiah" | "franc" | "hong_kong_dollar" | "new_zealand_dollar" | "krona" | "norwegian_krone" | "mexican_peso" | "rand" | "new_taiwan_dollar" | "danish_krone" | "zloty" | "baht" | "forint" | "koruna" | "shekel" | "chilean_peso" | "philippine_peso" | "dirham" | "colombian_peso" | "riyal" | "ringgit" | "leu" | "argentine_peso" | "uruguayan_peso")
export type Color1 = ("default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red")
export type Function = ("count" | "count_values" | "empty" | "not_empty" | "unique" | "show_unique" | "percent_empty" | "percent_not_empty" | "sum" | "average" | "median" | "min" | "max" | "range" | "earliest_date" | "latest_date" | "date_range" | "checked" | "unchecked" | "percent_checked" | "percent_unchecked" | "count_per_group" | "percent_per_group" | "show_original")
export type CreateDatabaseOutput = (Item35 | Item36)
export type CreatePageInput = ({
  parent: LinkToPage1
  properties: ({
    [k: string]: ({
      title: (Items1 | Items2 | Items3)[]
      type?: "title"
    } | {
      rich_text: (Items1 | Items2 | Items3)[]
      type?: "rich_text"
    } | {
      number: (number | null)
      type?: "number"
    } | {
      url: (string | null)
      type?: "url"
    } | {
      select: (Items61 | null | Items62)
      type?: "select"
    } | {
      multi_select: (Items61 | Items62)[]
      type?: "multi_select"
    } | {
      people: (Database | User | User1)[]
      type?: "people"
    } | {
      email: (string | null)
      type?: "email"
    } | {
      phone_number: (string | null)
      type?: "phone_number"
    } | {
      date: (Date | null)
      type?: "date"
    } | {
      checkbox: boolean
      type?: "checkbox"
    } | {
      relation: Database[]
      type?: "relation"
    } | {
      files: (Items63 | Items64)[]
      type?: "files"
    } | {
      status: (Items61 | null | Items62)
      type?: "status"
    })
  } | {
    [k: string]: ((Items1 | Items2 | Items3)[] | number | null | string | Items61 | Items62 | (Items61 | Items62)[] | (Database | User | User1)[] | Date | boolean | Database[] | (Items63 | Items64)[])
  })
  icon?: (Icon | null | Icon1)
  cover?: (Icon1 | null)
  content?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items17 | Items18 | Items43 | Items44 | Items45 | Items46 | Items47 | Items48 | Items49 | Items50 | Items51 | Items52 | Items53 | Items54 | Items55)[]
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items17 | Items18 | Items43 | Items44 | Items45 | Items46 | Items47 | Items48 | Items49 | Items50 | Items51 | Items52 | Items53 | Items54 | Items55)[]
} | {
  parent: LinkToPage
  properties: {
    title?: ({
      title: (Items1 | Items2 | Items3)[]
      type?: "title"
    } | (Items1 | Items2 | Items3)[])
  }
  icon?: (Icon | null | Icon1)
  cover?: (Icon1 | null)
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items17 | Items18 | Items43 | Items44 | Items45 | Items46 | Items47 | Items48 | Items49 | Items50 | Items51 | Items52 | Items53 | Items54 | Items55)[]
})
export type CreatePageOutput = (Item37 | Item38)
export type GetUserOutput1 = (User4 | User5)
export type GetUserOutput2 = (User4 | User5)
export type GetUserOutput3 = (User4 | User5)
export type GetUserOutput4 = (User4 | User5)
export type DeleteBlockInput = Item
export type DeleteBlockOutput = (Item1 | (Item2 | Item3 | Item4 | Item5 | Item6 | Item7 | Item8 | Item9 | Item10 | Item11 | Item12 | Item13 | Item14 | Item15 | Item16 | Item17 | Item18 | Item19 | Item20 | Item21 | Item22 | Item23 | Item24 | Item25 | Item26 | Item27 | Item28 | Item29 | Item30 | Item31 | Item32 | Item33 | Item34))
export type GetBlockInput = Item
export type GetBlockOutput = (Item1 | (Item2 | Item3 | Item4 | Item5 | Item6 | Item7 | Item8 | Item9 | Item10 | Item11 | Item12 | Item13 | Item14 | Item15 | Item16 | Item17 | Item18 | Item19 | Item20 | Item21 | Item22 | Item23 | Item24 | Item25 | Item26 | Item27 | Item28 | Item29 | Item30 | Item31 | Item32 | Item33 | Item34))
export type GetBlockChildrenInput = {
  /**
   * ID of the block
   */
  block_id: string
  /**
   * The cursor to start from. If not provided, the default is to start from the beginning of the list.
   */
  start_cursor?: string
  /**
   * The number of results to return. The maximum is 100.
   */
  page_size?: number
}
export type GetBotInfoOutput = (User4 | User5)
export type GetCommentsInput = {
  /**
   * ID of the block
   */
  block_id: string
  /**
   * The cursor to start from. If not provided, the default is to start from the beginning of the list.
   */
  start_cursor?: string
  /**
   * The number of results to return. The maximum is 100.
   */
  page_size?: number
}
export type GetDatabaseInput = {
  /**
   * ID of the database
   */
  database_id: string
}
export type GetDatabaseOutput = (Item35 | Item36)
export type GetPageInput = {
  /**
   * ID of the page
   */
  page_id: string
  /**
   * The properties to filter by
   */
  filter_properties?: string[]
}
export type GetPageOutput = (Item37 | Item38)
export type GetUserInput = {
  /**
   * ID of the user you would like info about
   */
  user_id: string
}
export type GetUserOutput5 = (User4 | User5)
export type ListUsersInput = {
  /**
   * The cursor to start from. If not provided, the default is to start from the beginning of the list.
   */
  start_cursor?: string
  /**
   * The number of results to return. The maximum is 100.
   */
  page_size?: number
}
export type GetUserOutput6 = (User4 | User5)
export type QueryDatabaseInput = ({
  /**
   * ID of the database
   */
  database_id: string
  /**
   * The list of database properties you want to receive back in the responses – you need to provide ids
   */
  filter_properties?: string[]
} & {
  sorts?: ({
    property: string
    direction: ("ascending" | "descending")
  } | {
    timestamp: ("created_time" | "last_edited_time")
    direction: ("ascending" | "descending")
  })[]
  filter?: ({
    or: ((Items71 | Items72 | Items73 | Items74 | Items75 | Items76 | Items77 | Items78 | Items79 | Items80 | Items81 | Items82 | Items83 | Items84 | Items85 | Items86 | Items87 | Items88 | Items89 | Items90) | {
      created_time: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
      timestamp: "created_time"
      type?: "created_time"
    } | {
      last_edited_time: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
      timestamp: "last_edited_time"
      type?: "last_edited_time"
    } | {
      or: (Items71 | Items72 | Items73 | Items74 | Items75 | Items76 | Items77 | Items78 | Items79 | Items80 | Items81 | Items82 | Items83 | Items84 | Items85 | Items86 | Items87 | Items88 | Items89 | Items90)[]
    } | {
      and: (Items71 | Items72 | Items73 | Items74 | Items75 | Items76 | Items77 | Items78 | Items79 | Items80 | Items81 | Items82 | Items83 | Items84 | Items85 | Items86 | Items87 | Items88 | Items89 | Items90)[]
    })[]
  } | {
    and: ((Items71 | Items72 | Items73 | Items74 | Items75 | Items76 | Items77 | Items78 | Items79 | Items80 | Items81 | Items82 | Items83 | Items84 | Items85 | Items86 | Items87 | Items88 | Items89 | Items90) | {
      created_time: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
      timestamp: "created_time"
      type?: "created_time"
    } | {
      last_edited_time: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
      timestamp: "last_edited_time"
      type?: "last_edited_time"
    } | {
      or: (Items71 | Items72 | Items73 | Items74 | Items75 | Items76 | Items77 | Items78 | Items79 | Items80 | Items81 | Items82 | Items83 | Items84 | Items85 | Items86 | Items87 | Items88 | Items89 | Items90)[]
    } | {
      and: (Items71 | Items72 | Items73 | Items74 | Items75 | Items76 | Items77 | Items78 | Items79 | Items80 | Items81 | Items82 | Items83 | Items84 | Items85 | Items86 | Items87 | Items88 | Items89 | Items90)[]
    })[]
  } | (Items71 | Items72 | Items73 | Items74 | Items75 | Items76 | Items77 | Items78 | Items79 | Items80 | Items81 | Items82 | Items83 | Items84 | Items85 | Items86 | Items87 | Items88 | Items89 | Items90) | {
    created_time: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
    timestamp: "created_time"
    type?: "created_time"
  } | {
    last_edited_time: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
    timestamp: "last_edited_time"
    type?: "last_edited_time"
  })
  start_cursor?: string
  page_size?: number
  archived?: boolean
})
export type SearchInput = {
  sort?: {
    timestamp: "last_edited_time"
    direction: ("ascending" | "descending")
  }
  query?: string
  start_cursor?: string
  page_size?: number
  filter?: {
    property: "object"
    value: ("page" | "database")
  }
}
export type UpdateBlockInput = (Item & ({
  embed: {
    url?: string
    caption?: (Items1 | Items2 | Items3)[]
  }
  type?: "embed"
  archived?: boolean
} | {
  bookmark: {
    url?: string
    caption?: (Items1 | Items2 | Items3)[]
  }
  type?: "bookmark"
  archived?: boolean
} | {
  image: Audio3
  type?: "image"
  archived?: boolean
} | {
  video: Audio3
  type?: "video"
  archived?: boolean
} | {
  pdf: Audio3
  type?: "pdf"
  archived?: boolean
} | {
  file: Audio3
  type?: "file"
  archived?: boolean
} | {
  audio: Audio3
  type?: "audio"
  archived?: boolean
} | {
  code: {
    rich_text?: (Items1 | Items2 | Items3)[]
    language?: Language
    caption?: (Items1 | Items2 | Items3)[]
  }
  type?: "code"
  archived?: boolean
} | {
  equation: Equation
  type?: "equation"
  archived?: boolean
} | {
  divider: Bot
  type?: "divider"
  archived?: boolean
} | {
  breadcrumb: Bot
  type?: "breadcrumb"
  archived?: boolean
} | {
  table_of_contents: TableOfContents
  type?: "table_of_contents"
  archived?: boolean
} | {
  link_to_page: (LinkToPage | LinkToPage1 | LinkToPage2)
  type?: "link_to_page"
  archived?: boolean
} | {
  table_row: TableRow
  type?: "table_row"
  archived?: boolean
} | {
  heading_1: Heading_31
  type?: "heading_1"
  archived?: boolean
} | {
  heading_2: Heading_31
  type?: "heading_2"
  archived?: boolean
} | {
  heading_3: Heading_31
  type?: "heading_3"
  archived?: boolean
} | {
  paragraph: Toggle
  type?: "paragraph"
  archived?: boolean
} | {
  bulleted_list_item: Toggle
  type?: "bulleted_list_item"
  archived?: boolean
} | {
  numbered_list_item: Toggle
  type?: "numbered_list_item"
  archived?: boolean
} | {
  quote: Toggle
  type?: "quote"
  archived?: boolean
} | {
  to_do: {
    rich_text?: (Items1 | Items2 | Items3)[]
    checked?: boolean
    color?: Color
  }
  type?: "to_do"
  archived?: boolean
} | {
  toggle: Toggle
  type?: "toggle"
  archived?: boolean
} | {
  template: Template
  type?: "template"
  archived?: boolean
} | {
  callout: {
    rich_text?: (Items1 | Items2 | Items3)[]
    icon?: (Icon | Icon1)
    color?: Color
  }
  type?: "callout"
  archived?: boolean
} | {
  synced_block: SyncedBlock
  type?: "synced_block"
  archived?: boolean
} | {
  table: {
    has_column_header?: boolean
    has_row_header?: boolean
  }
  type?: "table"
  archived?: boolean
} | {
  archived?: boolean
}))
export type UpdateBlockOutput = (Item1 | (Item2 | Item3 | Item4 | Item5 | Item6 | Item7 | Item8 | Item9 | Item10 | Item11 | Item12 | Item13 | Item14 | Item15 | Item16 | Item17 | Item18 | Item19 | Item20 | Item21 | Item22 | Item23 | Item24 | Item25 | Item26 | Item27 | Item28 | Item29 | Item30 | Item31 | Item32 | Item33 | Item34))
export type UpdateDatabaseInput = ({
  /**
   * ID of the database
   */
  database_id: string
} & {
  title?: (Items1 | Items2 | Items3)[]
  description?: (Items1 | Items2 | Items3)[]
  icon?: (Icon | null | Icon1)
  cover?: (Icon1 | null)
  properties?: {
    [k: string]: ({
      number: {
        format?: Format
      }
      type?: "number"
      name?: string
    } | null | {
      formula: {
        expression?: string
      }
      type?: "formula"
      name?: string
    } | {
      select: {
        options?: (Items61 | Items62)[]
      }
      type?: "select"
      name?: string
    } | {
      multi_select: {
        options?: (Items61 | Items62)[]
      }
      type?: "multi_select"
      name?: string
    } | {
      status: Bot
      type?: "status"
      name?: string
    } | {
      relation: ({
        single_property: Bot
        database_id: string
        type?: "single_property"
      } | {
        dual_property: Bot
        database_id: string
        type?: "dual_property"
      })
      type?: "relation"
      name?: string
    } | {
      rollup: ({
        rollup_property_name: string
        relation_property_name: string
        function: Function
        rollup_property_id?: string
        relation_property_id?: string
      } | {
        rollup_property_name: string
        relation_property_id: string
        function: Function
        relation_property_name?: string
        rollup_property_id?: string
      } | {
        relation_property_name: string
        rollup_property_id: string
        function: Function
        rollup_property_name?: string
        relation_property_id?: string
      } | {
        rollup_property_id: string
        relation_property_id: string
        function: Function
        rollup_property_name?: string
        relation_property_name?: string
      })
      type?: "rollup"
      name?: string
    } | {
      title: Bot
      type?: "title"
      name?: string
    } | {
      rich_text: Bot
      type?: "rich_text"
      name?: string
    } | {
      url: Bot
      type?: "url"
      name?: string
    } | {
      people: Bot
      type?: "people"
      name?: string
    } | {
      files: Bot
      type?: "files"
      name?: string
    } | {
      email: Bot
      type?: "email"
      name?: string
    } | {
      phone_number: Bot
      type?: "phone_number"
      name?: string
    } | {
      date: Bot
      type?: "date"
      name?: string
    } | {
      checkbox: Bot
      type?: "checkbox"
      name?: string
    } | {
      created_by: Bot
      type?: "created_by"
      name?: string
    } | {
      created_time: Bot
      type?: "created_time"
      name?: string
    } | {
      last_edited_by: Bot
      type?: "last_edited_by"
      name?: string
    } | {
      last_edited_time: Bot
      type?: "last_edited_time"
      name?: string
    } | {
      name: string
    })
  }
  is_inline?: boolean
  archived?: boolean
})
export type UpdateDatabaseOutput = (Item35 | Item36)
export type UpdatePageInput = ({
  /**
   * ID of the page
   */
  page_id: string
} & {
  properties?: ({
    [k: string]: ({
      title: (Items1 | Items2 | Items3)[]
      type?: "title"
    } | {
      rich_text: (Items1 | Items2 | Items3)[]
      type?: "rich_text"
    } | {
      number: (number | null)
      type?: "number"
    } | {
      url: (string | null)
      type?: "url"
    } | {
      select: (Items61 | null | Items62)
      type?: "select"
    } | {
      multi_select: (Items61 | Items62)[]
      type?: "multi_select"
    } | {
      people: (Database | User | User1)[]
      type?: "people"
    } | {
      email: (string | null)
      type?: "email"
    } | {
      phone_number: (string | null)
      type?: "phone_number"
    } | {
      date: (Date | null)
      type?: "date"
    } | {
      checkbox: boolean
      type?: "checkbox"
    } | {
      relation: Database[]
      type?: "relation"
    } | {
      files: (Items63 | Items64)[]
      type?: "files"
    } | {
      status: (Items61 | null | Items62)
      type?: "status"
    })
  } | {
    [k: string]: ((Items1 | Items2 | Items3)[] | number | null | string | Items61 | Items62 | (Items61 | Items62)[] | (Database | User | User1)[] | Date | boolean | Database[] | (Items63 | Items64)[])
  })
  icon?: (Icon | null | Icon1)
  cover?: (Icon1 | null)
  archived?: boolean
})
export type UpdatePageOutput = (Item37 | Item38)

export interface Item {
  /**
   * ID of the block
   */
  block_id: string
}
export interface Items {
  embed: Bookmark
  type?: "embed"
  object?: "block"
}
export interface Bookmark {
  url: string
  caption?: (Items1 | Items2 | Items3)[]
}
export interface Items1 {
  text: Text
  type?: "text"
  annotations?: Annotations
}
export interface Text {
  content: string
  link?: (Link | null)
}
export interface Link {
  url: string
}
export interface Annotations {
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  underline?: boolean
  code?: boolean
  color?: Color
}
export interface Items2 {
  mention: (Mention | Mention1 | Mention2 | Mention3)
  type?: "mention"
  annotations?: Annotations
}
export interface Mention {
  user: (Database | User | User1)
}
export interface Database {
  id: string
}
export interface User {
  person: Person
  id: string
  type?: "person"
  name?: (string | null)
  avatar_url?: (string | null)
  object?: "user"
}
export interface Person {
  email?: string
}
export interface User1 {
  bot: (Bot | Bot1)
  id: string
  type?: "bot"
  name?: (string | null)
  avatar_url?: (string | null)
  object?: "user"
}
export interface Bot {
  [k: string]: {
    [k: string]: unknown
  }
}
export interface Bot1 {
  owner: (Owner | Owner1)
  workspace_name: (string | null)
}
export interface Owner {
  type: "user"
  user: (User2 | User3)
}
export interface User2 {
  type: "person"
  person: Person1
  name: (string | null)
  avatar_url: (string | null)
  id: string
  object: "user"
}
export interface Person1 {
  email: string
}
export interface User3 {
  id: string
  object: "user"
}
export interface Owner1 {
  type: "workspace"
  workspace: true
}
export interface Mention1 {
  date: Date
}
export interface Date {
  start: string
  end?: (string | null)
  time_zone?: (TimeZone | null)
}
export interface Mention2 {
  page: Database
}
export interface Mention3 {
  database: Database
}
export interface Items3 {
  equation: Equation
  type?: "equation"
  annotations?: Annotations
}
export interface Equation {
  expression: string
}
export interface Items4 {
  bookmark: Bookmark
  type?: "bookmark"
  object?: "block"
}
export interface Items5 {
  image: Audio
  type?: "image"
  object?: "block"
}
export interface Audio {
  external: Link
  type?: "external"
  caption?: (Items1 | Items2 | Items3)[]
}
export interface Items6 {
  video: Audio
  type?: "video"
  object?: "block"
}
export interface Items7 {
  pdf: Audio
  type?: "pdf"
  object?: "block"
}
export interface Items8 {
  file: Audio
  type?: "file"
  object?: "block"
}
export interface Items9 {
  audio: Audio
  type?: "audio"
  object?: "block"
}
export interface Items10 {
  code: Code
  type?: "code"
  object?: "block"
}
export interface Code {
  rich_text: (Items1 | Items2 | Items3)[]
  language: Language
  caption?: (Items1 | Items2 | Items3)[]
}
export interface Items11 {
  equation: Equation
  type?: "equation"
  object?: "block"
}
export interface Items12 {
  divider: Bot
  type?: "divider"
  object?: "block"
}
export interface Items13 {
  breadcrumb: Bot
  type?: "breadcrumb"
  object?: "block"
}
export interface Items14 {
  table_of_contents: TableOfContents
  type?: "table_of_contents"
  object?: "block"
}
export interface TableOfContents {
  color?: Color
}
export interface Items15 {
  link_to_page: (LinkToPage | LinkToPage1 | LinkToPage2)
  type?: "link_to_page"
  object?: "block"
}
export interface LinkToPage {
  page_id: string
  type?: "page_id"
}
export interface LinkToPage1 {
  database_id: string
  type?: "database_id"
}
export interface LinkToPage2 {
  comment_id: string
  type?: "comment_id"
}
export interface Items16 {
  table_row: TableRow
  type?: "table_row"
  object?: "block"
}
export interface TableRow {
  cells: (Items1 | Items2 | Items3)[][]
}
export interface Items17 {
  column_list: ColumnList
  type?: "column_list"
  object?: "block"
}
export interface ColumnList {
  children: Items18[]
}
export interface Items18 {
  column: Column
  type?: "column"
  object?: "block"
}
export interface Column {
  children: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items19 | Items32 | Items33 | Items34 | Items35 | Items36 | Items37 | Items38 | Items39 | Items40 | Items41 | Items42)[]
}
export interface Items19 {
  heading_1: Heading_3
  type?: "heading_1"
  object?: "block"
}
export interface Heading_3 {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
  is_toggleable?: boolean
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items20 | Items21 | Items22 | Items23 | Items24 | Items25 | Items26 | Items27 | Items28 | Items29 | Items30 | Items31)[]
}
export interface Items20 {
  heading_1: Heading_31
  type?: "heading_1"
  object?: "block"
}
export interface Heading_31 {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
  is_toggleable?: boolean
}
export interface Items21 {
  heading_2: Heading_31
  type?: "heading_2"
  object?: "block"
}
export interface Items22 {
  heading_3: Heading_31
  type?: "heading_3"
  object?: "block"
}
export interface Items23 {
  paragraph: Toggle
  type?: "paragraph"
  object?: "block"
}
export interface Toggle {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
}
export interface Items24 {
  bulleted_list_item: Toggle
  type?: "bulleted_list_item"
  object?: "block"
}
export interface Items25 {
  numbered_list_item: Toggle
  type?: "numbered_list_item"
  object?: "block"
}
export interface Items26 {
  quote: Toggle
  type?: "quote"
  object?: "block"
}
export interface Items27 {
  to_do: ToDo
  type?: "to_do"
  object?: "block"
}
export interface ToDo {
  rich_text: (Items1 | Items2 | Items3)[]
  checked?: boolean
  color?: Color
}
export interface Items28 {
  toggle: Toggle
  type?: "toggle"
  object?: "block"
}
export interface Items29 {
  template: Template
  type?: "template"
  object?: "block"
}
export interface Template {
  rich_text: (Items1 | Items2 | Items3)[]
}
export interface Items30 {
  callout: Callout
  type?: "callout"
  object?: "block"
}
export interface Callout {
  rich_text: (Items1 | Items2 | Items3)[]
  icon?: (Icon | Icon1)
  color?: Color
}
export interface Icon {
  emoji: string
  type?: "emoji"
}
export interface Icon1 {
  external: Link
  type?: "external"
}
export interface Items31 {
  synced_block: SyncedBlock
  type?: "synced_block"
  object?: "block"
}
export interface SyncedBlock {
  synced_from: (SyncedFrom | null)
}
export interface SyncedFrom {
  block_id: string
  type?: "block_id"
}
export interface Items32 {
  heading_2: Heading_3
  type?: "heading_2"
  object?: "block"
}
export interface Items33 {
  heading_3: Heading_3
  type?: "heading_3"
  object?: "block"
}
export interface Items34 {
  paragraph: Toggle1
  type?: "paragraph"
  object?: "block"
}
export interface Toggle1 {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items20 | Items21 | Items22 | Items23 | Items24 | Items25 | Items26 | Items27 | Items28 | Items29 | Items30 | Items31)[]
}
export interface Items35 {
  bulleted_list_item: Toggle1
  type?: "bulleted_list_item"
  object?: "block"
}
export interface Items36 {
  numbered_list_item: Toggle1
  type?: "numbered_list_item"
  object?: "block"
}
export interface Items37 {
  quote: Toggle1
  type?: "quote"
  object?: "block"
}
export interface Items38 {
  to_do: ToDo1
  type?: "to_do"
  object?: "block"
}
export interface ToDo1 {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items20 | Items21 | Items22 | Items23 | Items24 | Items25 | Items26 | Items27 | Items28 | Items29 | Items30 | Items31)[]
  checked?: boolean
}
export interface Items39 {
  toggle: Toggle1
  type?: "toggle"
  object?: "block"
}
export interface Items40 {
  template: Template1
  type?: "template"
  object?: "block"
}
export interface Template1 {
  rich_text: (Items1 | Items2 | Items3)[]
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items20 | Items21 | Items22 | Items23 | Items24 | Items25 | Items26 | Items27 | Items28 | Items29 | Items30 | Items31)[]
}
export interface Items41 {
  callout: Callout1
  type?: "callout"
  object?: "block"
}
export interface Callout1 {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items20 | Items21 | Items22 | Items23 | Items24 | Items25 | Items26 | Items27 | Items28 | Items29 | Items30 | Items31)[]
  icon?: (Icon | Icon1)
}
export interface Items42 {
  synced_block: SyncedBlock1
  type?: "synced_block"
  object?: "block"
}
export interface SyncedBlock1 {
  synced_from: (SyncedFrom | null)
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items20 | Items21 | Items22 | Items23 | Items24 | Items25 | Items26 | Items27 | Items28 | Items29 | Items30 | Items31)[]
}
export interface Items43 {
  table: Table
  type?: "table"
  object?: "block"
}
export interface Table {
  table_width: number
  children: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items20 | Items21 | Items22 | Items23 | Items24 | Items25 | Items26 | Items27 | Items28 | Items29 | Items30 | Items31)[]
  has_column_header?: boolean
  has_row_header?: boolean
}
export interface Items44 {
  heading_1: Heading_32
  type?: "heading_1"
  object?: "block"
}
export interface Heading_32 {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
  is_toggleable?: boolean
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items19 | Items32 | Items33 | Items34 | Items35 | Items36 | Items37 | Items38 | Items39 | Items40 | Items41 | Items42)[]
}
export interface Items45 {
  heading_2: Heading_32
  type?: "heading_2"
  object?: "block"
}
export interface Items46 {
  heading_3: Heading_32
  type?: "heading_3"
  object?: "block"
}
export interface Items47 {
  paragraph: Toggle2
  type?: "paragraph"
  object?: "block"
}
export interface Toggle2 {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items19 | Items32 | Items33 | Items34 | Items35 | Items36 | Items37 | Items38 | Items39 | Items40 | Items41 | Items42)[]
}
export interface Items48 {
  bulleted_list_item: Toggle2
  type?: "bulleted_list_item"
  object?: "block"
}
export interface Items49 {
  numbered_list_item: Toggle2
  type?: "numbered_list_item"
  object?: "block"
}
export interface Items50 {
  quote: Toggle2
  type?: "quote"
  object?: "block"
}
export interface Items51 {
  to_do: ToDo2
  type?: "to_do"
  object?: "block"
}
export interface ToDo2 {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items19 | Items32 | Items33 | Items34 | Items35 | Items36 | Items37 | Items38 | Items39 | Items40 | Items41 | Items42)[]
  checked?: boolean
}
export interface Items52 {
  toggle: Toggle2
  type?: "toggle"
  object?: "block"
}
export interface Items53 {
  template: Template2
  type?: "template"
  object?: "block"
}
export interface Template2 {
  rich_text: (Items1 | Items2 | Items3)[]
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items19 | Items32 | Items33 | Items34 | Items35 | Items36 | Items37 | Items38 | Items39 | Items40 | Items41 | Items42)[]
}
export interface Items54 {
  callout: Callout2
  type?: "callout"
  object?: "block"
}
export interface Callout2 {
  rich_text: (Items1 | Items2 | Items3)[]
  color?: Color
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items19 | Items32 | Items33 | Items34 | Items35 | Items36 | Items37 | Items38 | Items39 | Items40 | Items41 | Items42)[]
  icon?: (Icon | Icon1)
}
export interface Items55 {
  synced_block: SyncedBlock2
  type?: "synced_block"
  object?: "block"
}
export interface SyncedBlock2 {
  synced_from: (SyncedFrom | null)
  children?: (Items | Items4 | Items5 | Items6 | Items7 | Items8 | Items9 | Items10 | Items11 | Items12 | Items13 | Items14 | Items15 | Items16 | Items19 | Items32 | Items33 | Items34 | Items35 | Items36 | Items37 | Items38 | Items39 | Items40 | Items41 | Items42)[]
}
export interface AppendBlockChildrenOutput {
  type: "block"
  block: Bot
  object: "list"
  next_cursor: (string | null)
  has_more: boolean
  results: (Item1 | (Item2 | Item3 | Item4 | Item5 | Item6 | Item7 | Item8 | Item9 | Item10 | Item11 | Item12 | Item13 | Item14 | Item15 | Item16 | Item17 | Item18 | Item19 | Item20 | Item21 | Item22 | Item23 | Item24 | Item25 | Item26 | Item27 | Item28 | Item29 | Item30 | Item31 | Item32 | Item33 | Item34))[]
}
export interface Item1 {
  object: "block"
  id: string
}
export interface Item2 {
  type: "paragraph"
  paragraph: Toggle3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Toggle3 {
  rich_text: (Items56 | Items57 | Items58)[]
  color: Color
}
export interface Items56 {
  type: "text"
  text: Text1
  annotations: Annotations1
  plain_text: string
  href: (string | null)
}
export interface Text1 {
  content: string
  link: (Link | null)
}
export interface Annotations1 {
  bold: boolean
  italic: boolean
  strikethrough: boolean
  underline: boolean
  code: boolean
  color: Color
}
export interface Items57 {
  type: "mention"
  mention: (Mention4 | Mention5 | Mention6 | Mention7 | Mention8 | Mention9)
  annotations: Annotations1
  plain_text: string
  href: (string | null)
}
export interface Mention4 {
  type: "user"
  user: (User3 | GetUserOutput)
}
export interface User4 {
  type: "person"
  person: Person
  name: (string | null)
  avatar_url: (string | null)
  id: string
  object: "user"
}
export interface User5 {
  type: "bot"
  bot: (Bot | Bot1)
  name: (string | null)
  avatar_url: (string | null)
  id: string
  object: "user"
}
export interface Mention5 {
  type: "date"
  date: Date1
}
export interface Date1 {
  start: string
  end: (string | null)
  time_zone: (TimeZone | null)
}
export interface Mention6 {
  type: "link_preview"
  link_preview: Link
}
export interface Mention7 {
  type: "template_mention"
  template_mention: (TemplateMention | TemplateMention1)
}
export interface TemplateMention {
  type: "template_mention_date"
  template_mention_date: TemplateMentionDate
}
export interface TemplateMention1 {
  type: "template_mention_user"
  template_mention_user: "me"
}
export interface Mention8 {
  type: "page"
  page: Database
}
export interface Mention9 {
  type: "database"
  database: Database
}
export interface Items58 {
  type: "equation"
  equation: Equation
  annotations: Annotations1
  plain_text: string
  href: (string | null)
}
export interface Parent {
  type: "database_id"
  database_id: string
}
export interface Parent1 {
  type: "page_id"
  page_id: string
}
export interface Parent2 {
  type: "block_id"
  block_id: string
}
export interface Item3 {
  type: "heading_1"
  heading_1: Toggle3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item4 {
  type: "heading_2"
  heading_2: Toggle3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item5 {
  type: "heading_3"
  heading_3: Toggle3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item6 {
  type: "bulleted_list_item"
  bulleted_list_item: Toggle3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item7 {
  type: "numbered_list_item"
  numbered_list_item: Toggle3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item8 {
  type: "quote"
  quote: Toggle3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item9 {
  type: "to_do"
  to_do: ToDo3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface ToDo3 {
  rich_text: (Items56 | Items57 | Items58)[]
  color: Color
  checked: boolean
}
export interface Item10 {
  type: "toggle"
  toggle: Toggle3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item11 {
  type: "template"
  template: Template3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Template3 {
  rich_text: (Items56 | Items57 | Items58)[]
}
export interface Item12 {
  type: "synced_block"
  synced_block: SyncedBlock3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface SyncedBlock3 {
  synced_from: (SyncedFrom1 | null)
}
export interface SyncedFrom1 {
  type: "block_id"
  block_id: string
}
export interface Item13 {
  type: "child_page"
  child_page: ChildDatabase
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface ChildDatabase {
  title: string
}
export interface Item14 {
  type: "child_database"
  child_database: ChildDatabase
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item15 {
  type: "equation"
  equation: Equation
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item16 {
  type: "code"
  code: Code1
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Code1 {
  rich_text: (Items56 | Items57 | Items58)[]
  caption: (Items56 | Items57 | Items58)[]
  language: Language
}
export interface Item17 {
  type: "callout"
  callout: Callout3
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Callout3 {
  rich_text: (Items56 | Items57 | Items58)[]
  color: Color
  icon: (Icon2 | null | Icon3 | Icon4)
}
export interface Icon2 {
  type: "emoji"
  emoji: string
}
export interface Icon3 {
  type: "external"
  external: Link
}
export interface Icon4 {
  type: "file"
  file: File
}
export interface File {
  url: string
  expiry_time: string
}
export interface Item18 {
  type: "divider"
  divider: Bot
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item19 {
  type: "breadcrumb"
  breadcrumb: Bot
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item20 {
  type: "table_of_contents"
  table_of_contents: TableOfContents1
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface TableOfContents1 {
  color: Color
}
export interface Item21 {
  type: "column_list"
  column_list: Bot
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item22 {
  type: "column"
  column: Bot
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item23 {
  type: "link_to_page"
  link_to_page: (LinkToPage3 | LinkToPage4 | LinkToPage5)
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface LinkToPage3 {
  type: "page_id"
  page_id: string
}
export interface LinkToPage4 {
  type: "database_id"
  database_id: string
}
export interface LinkToPage5 {
  type: "comment_id"
  comment_id: string
}
export interface Item24 {
  type: "table"
  table: Table1
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Table1 {
  has_column_header: boolean
  has_row_header: boolean
  table_width: number
}
export interface Item25 {
  type: "table_row"
  table_row: TableRow1
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface TableRow1 {
  cells: (Items56 | Items57 | Items58)[][]
}
export interface Item26 {
  type: "embed"
  embed: Bookmark1
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Bookmark1 {
  url: string
  caption: (Items56 | Items57 | Items58)[]
}
export interface Item27 {
  type: "bookmark"
  bookmark: Bookmark1
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item28 {
  type: "image"
  image: (Audio1 | Audio2)
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Audio1 {
  type: "external"
  external: Link
  caption: (Items56 | Items57 | Items58)[]
}
export interface Audio2 {
  type: "file"
  file: File
  caption: (Items56 | Items57 | Items58)[]
}
export interface Item29 {
  type: "video"
  video: (Audio1 | Audio2)
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item30 {
  type: "pdf"
  pdf: (Audio1 | Audio2)
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item31 {
  type: "file"
  file: (Audio1 | Audio2)
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item32 {
  type: "audio"
  audio: (Audio1 | Audio2)
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item33 {
  type: "link_preview"
  link_preview: Link
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item34 {
  type: "unsupported"
  unsupported: Bot
  parent: (Parent | Parent1 | Parent2 | Owner1)
  object: "block"
  id: string
  created_time: string
  created_by: User3
  last_edited_time: string
  last_edited_by: User3
  has_children: boolean
  archived: boolean
}
export interface Item35 {
  object: "database"
  id: string
  properties: Properties
}
export interface Properties {
  [k: string]: (AdditionalProperties | AdditionalProperties1 | AdditionalProperties2 | AdditionalProperties3 | AdditionalProperties4 | AdditionalProperties5 | AdditionalProperties6 | AdditionalProperties7 | AdditionalProperties8 | AdditionalProperties9 | AdditionalProperties10 | AdditionalProperties11 | AdditionalProperties12 | AdditionalProperties13 | AdditionalProperties14 | AdditionalProperties15 | AdditionalProperties16 | AdditionalProperties17 | AdditionalProperties18 | AdditionalProperties19)
}
export interface AdditionalProperties {
  type: "number"
  number: Number
  id: string
  name: string
}
export interface Number {
  format: Format
}
export interface AdditionalProperties1 {
  type: "formula"
  formula: Equation
  id: string
  name: string
}
export interface AdditionalProperties2 {
  type: "select"
  select: MultiSelect
  id: string
  name: string
}
export interface MultiSelect {
  options: Items59[]
}
export interface Items59 {
  id: string
  name: string
  color: Color1
}
export interface AdditionalProperties3 {
  type: "multi_select"
  multi_select: MultiSelect
  id: string
  name: string
}
export interface AdditionalProperties4 {
  type: "status"
  status: Status
  id: string
  name: string
}
export interface Status {
  options: Items59[]
  groups: Items60[]
}
export interface Items60 {
  id: string
  name: string
  color: Color1
  option_ids: string[]
}
export interface AdditionalProperties5 {
  type: "relation"
  relation: (Relation | Relation1)
  id: string
  name: string
}
export interface Relation {
  type: "single_property"
  single_property: Bot
  database_id: string
}
export interface Relation1 {
  type: "dual_property"
  dual_property: DualProperty
  database_id: string
}
export interface DualProperty {
  synced_property_id: string
  synced_property_name: string
}
export interface AdditionalProperties6 {
  type: "rollup"
  rollup: Rollup
  id: string
  name: string
}
export interface Rollup {
  rollup_property_name: string
  relation_property_name: string
  rollup_property_id: string
  relation_property_id: string
  function: Function
}
export interface AdditionalProperties7 {
  type: "title"
  title: Bot
  id: string
  name: string
}
export interface AdditionalProperties8 {
  type: "rich_text"
  rich_text: Bot
  id: string
  name: string
}
export interface AdditionalProperties9 {
  type: "url"
  url: Bot
  id: string
  name: string
}
export interface AdditionalProperties10 {
  type: "people"
  people: Bot
  id: string
  name: string
}
export interface AdditionalProperties11 {
  type: "files"
  files: Bot
  id: string
  name: string
}
export interface AdditionalProperties12 {
  type: "email"
  email: Bot
  id: string
  name: string
}
export interface AdditionalProperties13 {
  type: "phone_number"
  phone_number: Bot
  id: string
  name: string
}
export interface AdditionalProperties14 {
  type: "date"
  date: Bot
  id: string
  name: string
}
export interface AdditionalProperties15 {
  type: "checkbox"
  checkbox: Bot
  id: string
  name: string
}
export interface AdditionalProperties16 {
  type: "created_by"
  created_by: Bot
  id: string
  name: string
}
export interface AdditionalProperties17 {
  type: "created_time"
  created_time: Bot
  id: string
  name: string
}
export interface AdditionalProperties18 {
  type: "last_edited_by"
  last_edited_by: Bot
  id: string
  name: string
}
export interface AdditionalProperties19 {
  type: "last_edited_time"
  last_edited_time: Bot
  id: string
  name: string
}
export interface Item36 {
  title: (Items56 | Items57 | Items58)[]
  description: (Items56 | Items57 | Items58)[]
  icon: (Icon2 | null | Icon3 | Icon4)
  cover: (Icon3 | null | Icon4)
  properties: Properties
  parent: (Parent1 | Owner1 | Parent2)
  created_by: User3
  last_edited_by: User3
  is_inline: boolean
  object: "database"
  id: string
  created_time: string
  last_edited_time: string
  archived: boolean
  url: string
}
export interface Items61 {
  id: string
  name?: string
  color?: Color1
}
export interface Items62 {
  name: string
  id?: string
  color?: Color1
}
export interface Items63 {
  file: File1
  name: string
  type?: "file"
}
export interface File1 {
  url: string
  expiry_time?: string
}
export interface Items64 {
  external: Link
  name: string
  type?: "external"
}
export interface Item37 {
  parent: (Parent | Parent1 | Parent2 | Owner1)
  properties: Properties1
  icon: (Icon2 | null | Icon3 | Icon4)
  cover: (Icon3 | null | Icon4)
  created_by: User3
  last_edited_by: User3
  object: "page"
  id: string
  created_time: string
  last_edited_time: string
  archived: boolean
  url: string
}
export interface Properties1 {
  [k: string]: (AdditionalProperties20 | AdditionalProperties21 | AdditionalProperties22 | AdditionalProperties23 | AdditionalProperties24 | AdditionalProperties25 | AdditionalProperties26 | AdditionalProperties27 | AdditionalProperties28 | AdditionalProperties29 | AdditionalProperties30 | AdditionalProperties31 | AdditionalProperties32 | AdditionalProperties33 | AdditionalProperties34 | AdditionalProperties35 | AdditionalProperties36 | AdditionalProperties37 | AdditionalProperties38 | AdditionalProperties39)
}
export interface AdditionalProperties20 {
  type: "number"
  number: (number | null)
  id: string
}
export interface AdditionalProperties21 {
  type: "url"
  url: (string | null)
  id: string
}
export interface AdditionalProperties22 {
  type: "select"
  select: (Items59 | null)
  id: string
}
export interface AdditionalProperties23 {
  type: "multi_select"
  multi_select: Items59[]
  id: string
}
export interface AdditionalProperties24 {
  type: "status"
  status: (Items59 | null)
  id: string
}
export interface AdditionalProperties25 {
  type: "date"
  date: (Date1 | null)
  id: string
}
export interface AdditionalProperties26 {
  type: "email"
  email: (string | null)
  id: string
}
export interface AdditionalProperties27 {
  type: "phone_number"
  phone_number: (string | null)
  id: string
}
export interface AdditionalProperties28 {
  type: "checkbox"
  checkbox: boolean
  id: string
}
export interface AdditionalProperties29 {
  type: "files"
  files: (Items65 | Items64)[]
  id: string
}
export interface Items65 {
  file: File
  name: string
  type?: "file"
}
export interface AdditionalProperties30 {
  type: "created_by"
  created_by: (User3 | GetUserOutput1)
  id: string
}
export interface AdditionalProperties31 {
  type: "created_time"
  created_time: string
  id: string
}
export interface AdditionalProperties32 {
  type: "last_edited_by"
  last_edited_by: (User3 | GetUserOutput2)
  id: string
}
export interface AdditionalProperties33 {
  type: "last_edited_time"
  last_edited_time: string
  id: string
}
export interface AdditionalProperties34 {
  type: "formula"
  formula: (Formula | Formula1 | Formula2 | Formula3)
  id: string
}
export interface Formula {
  type: "string"
  string: (string | null)
}
export interface Formula1 {
  type: "date"
  date: (Date1 | null)
}
export interface Formula2 {
  type: "number"
  number: (number | null)
}
export interface Formula3 {
  type: "boolean"
  boolean: (boolean | null)
}
export interface AdditionalProperties35 {
  type: "title"
  title: (Items56 | Items57 | Items58)[]
  id: string
}
export interface AdditionalProperties36 {
  type: "rich_text"
  rich_text: (Items56 | Items57 | Items58)[]
  id: string
}
export interface AdditionalProperties37 {
  type: "people"
  people: (User3 | GetUserOutput3)[]
  id: string
}
export interface AdditionalProperties38 {
  type: "relation"
  relation: Items66[]
  id: string
}
export interface Items66 {
  id: string
}
export interface AdditionalProperties39 {
  type: "rollup"
  rollup: (Rollup1 | Rollup2 | Rollup3)
  id: string
}
export interface Rollup1 {
  type: "number"
  number: (number | null)
  function: Function
}
export interface Rollup2 {
  type: "date"
  date: (Date1 | null)
  function: Function
}
export interface Rollup3 {
  type: "array"
  array: (Items67 | Items68 | Items69 | Items70)[]
  function: Function
}
export interface Items67 {
  type: "title"
  title: (Items56 | Items57 | Items58)[]
}
export interface Items68 {
  type: "rich_text"
  rich_text: (Items56 | Items57 | Items58)[]
}
export interface Items69 {
  type: "people"
  people: (User3 | GetUserOutput4)[]
}
export interface Items70 {
  type: "relation"
  relation: Items66[]
}
export interface Item38 {
  object: "page"
  id: string
}
export interface GetBlockChildrenOutput {
  type: "block"
  block: Bot
  object: "list"
  next_cursor: (string | null)
  has_more: boolean
  results: (Item1 | (Item2 | Item3 | Item4 | Item5 | Item6 | Item7 | Item8 | Item9 | Item10 | Item11 | Item12 | Item13 | Item14 | Item15 | Item16 | Item17 | Item18 | Item19 | Item20 | Item21 | Item22 | Item23 | Item24 | Item25 | Item26 | Item27 | Item28 | Item29 | Item30 | Item31 | Item32 | Item33 | Item34))[]
}
export interface GetCommentsOutput {
  type: "comment"
  comment: Bot
  object: "list"
  next_cursor: (string | null)
  has_more: boolean
  results: {
    object: "comment"
    id: string
    parent: (LinkToPage3 | SyncedFrom1)
    discussion_id: string
    rich_text: (Items56 | Items57 | Items58)[]
    created_by: User3
    created_time: string
    last_edited_time: string
  }[]
}
export interface ListUsersOutput {
  type: "user"
  user: Bot
  object: "list"
  next_cursor: (string | null)
  has_more: boolean
  results: GetUserOutput6[]
}
export interface Items71 {
  title: (Date2 | Select | MultiSelect1 | MultiSelect2 | RichText | RichText1 | (Number1 | Number2))
  property: string
  type?: "title"
}
export interface Date2 {
  equals: string
}
export interface Select {
  does_not_equal: string
}
export interface MultiSelect1 {
  contains: string
}
export interface MultiSelect2 {
  does_not_contain: string
}
export interface RichText {
  starts_with: string
}
export interface RichText1 {
  ends_with: string
}
export interface Number1 {
  is_empty: true
}
export interface Number2 {
  is_not_empty: true
}
export interface Items72 {
  rich_text: (Date2 | Select | MultiSelect1 | MultiSelect2 | RichText | RichText1 | (Number1 | Number2))
  property: string
  type?: "rich_text"
}
export interface Items73 {
  number: (Number3 | Number4 | Number5 | Number6 | Number7 | Number8 | (Number1 | Number2))
  property: string
  type?: "number"
}
export interface Number3 {
  equals: number
}
export interface Number4 {
  does_not_equal: number
}
export interface Number5 {
  greater_than: number
}
export interface Number6 {
  less_than: number
}
export interface Number7 {
  greater_than_or_equal_to: number
}
export interface Number8 {
  less_than_or_equal_to: number
}
export interface Items74 {
  checkbox: (Checkbox | Checkbox1)
  property: string
  type?: "checkbox"
}
export interface Checkbox {
  equals: boolean
}
export interface Checkbox1 {
  does_not_equal: boolean
}
export interface Items75 {
  select: (Date2 | Select | (Number1 | Number2))
  property: string
  type?: "select"
}
export interface Items76 {
  multi_select: (MultiSelect1 | MultiSelect2 | (Number1 | Number2))
  property: string
  type?: "multi_select"
}
export interface Items77 {
  status: (Date2 | Select | (Number1 | Number2))
  property: string
  type?: "status"
}
export interface Items78 {
  date: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
  property: string
  type?: "date"
}
export interface Date3 {
  before: string
}
export interface Date4 {
  after: string
}
export interface Date5 {
  on_or_before: string
}
export interface Date6 {
  on_or_after: string
}
export interface Date7 {
  this_week: Bot
}
export interface Date8 {
  past_week: Bot
}
export interface Date9 {
  past_month: Bot
}
export interface Date10 {
  past_year: Bot
}
export interface Date11 {
  next_week: Bot
}
export interface Date12 {
  next_month: Bot
}
export interface Date13 {
  next_year: Bot
}
export interface Items79 {
  people: (People | People1 | (Number1 | Number2))
  property: string
  type?: "people"
}
export interface People {
  contains: string
}
export interface People1 {
  does_not_contain: string
}
export interface Items80 {
  files: (Number1 | Number2)
  property: string
  type?: "files"
}
export interface Items81 {
  url: (Date2 | Select | MultiSelect1 | MultiSelect2 | RichText | RichText1 | (Number1 | Number2))
  property: string
  type?: "url"
}
export interface Items82 {
  email: (Date2 | Select | MultiSelect1 | MultiSelect2 | RichText | RichText1 | (Number1 | Number2))
  property: string
  type?: "email"
}
export interface Items83 {
  phone_number: (Date2 | Select | MultiSelect1 | MultiSelect2 | RichText | RichText1 | (Number1 | Number2))
  property: string
  type?: "phone_number"
}
export interface Items84 {
  relation: (People | People1 | (Number1 | Number2))
  property: string
  type?: "relation"
}
export interface Items85 {
  created_by: (People | People1 | (Number1 | Number2))
  property: string
  type?: "created_by"
}
export interface Items86 {
  created_time: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
  property: string
  type?: "created_time"
}
export interface Items87 {
  last_edited_by: (People | People1 | (Number1 | Number2))
  property: string
  type?: "last_edited_by"
}
export interface Items88 {
  last_edited_time: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
  property: string
  type?: "last_edited_time"
}
export interface Items89 {
  formula: (Formula4 | Every | Rollup4 | Rollup5)
  property: string
  type?: "formula"
}
export interface Formula4 {
  string: (Date2 | Select | MultiSelect1 | MultiSelect2 | RichText | RichText1 | (Number1 | Number2))
}
export interface Every {
  checkbox: (Checkbox | Checkbox1)
}
export interface Rollup4 {
  number: (Number3 | Number4 | Number5 | Number6 | Number7 | Number8 | (Number1 | Number2))
}
export interface Rollup5 {
  date: (Date2 | Date3 | Date4 | Date5 | Date6 | Date7 | Date8 | Date9 | Date10 | Date11 | Date12 | Date13 | (Number1 | Number2))
}
export interface Items90 {
  rollup: (Rollup6 | Rollup7 | Rollup8 | Rollup5 | Rollup4)
  property: string
  type?: "rollup"
}
export interface Rollup6 {
  any: (Every1 | Rollup4 | Every | Every2 | Every3 | Every4 | Rollup5 | Every5 | Every6)
}
export interface Every1 {
  rich_text: (Date2 | Select | MultiSelect1 | MultiSelect2 | RichText | RichText1 | (Number1 | Number2))
}
export interface Every2 {
  select: (Date2 | Select | (Number1 | Number2))
}
export interface Every3 {
  multi_select: (MultiSelect1 | MultiSelect2 | (Number1 | Number2))
}
export interface Every4 {
  relation: (People | People1 | (Number1 | Number2))
}
export interface Every5 {
  people: (People | People1 | (Number1 | Number2))
}
export interface Every6 {
  files: (Number1 | Number2)
}
export interface Rollup7 {
  none: (Every1 | Rollup4 | Every | Every2 | Every3 | Every4 | Rollup5 | Every5 | Every6)
}
export interface Rollup8 {
  every: (Every1 | Rollup4 | Every | Every2 | Every3 | Every4 | Rollup5 | Every5 | Every6)
}
export interface QueryDatabaseOutput {
  type: "page"
  page: Bot
  object: "list"
  next_cursor: (string | null)
  has_more: boolean
  results: (Item37 | Item38)[]
}
export interface SearchOutput {
  type: "page_or_database"
  page_or_database: Bot
  object: "list"
  next_cursor: (string | null)
  has_more: boolean
  results: (Item37 | Item38 | Item35 | Item36)[]
}
export interface Audio3 {
  caption?: (Items1 | Items2 | Items3)[]
  external?: Link
}

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
