export type SendgridTypes = (MailSendInput | MarketingContactsInput | MarketingContactsOutput)
export type ToEmailArray = {
  /**
   * The intended recipient's email address.
   */
  email: string
  /**
   * The intended recipient's name.
   */
  name?: string
}[]

export interface MailSendInput {
  /**
   * An array of messages and their metadata. Each object within personalizations can be thought of as an envelope - it defines who should receive an individual message and how that message should be handled. See our [Personalizations documentation](https://sendgrid.com/docs/for-developers/sending-email/personalizations/) for examples.
   * 
   * @maxItems 1000
   */
  personalizations: {
    from?: FromEmailObject
    to: ToEmailArray
    /**
     * An array of recipients who will receive a copy of your email. Each object in this array must contain the recipient's email address. Each object in the array may optionally contain the recipient's name.
     * 
     * @maxItems 1000
     */
    cc?: CCBCCEmailObject[]
    /**
     * An array of recipients who will receive a blind carbon copy of your email. Each object in this array must contain the recipient's email address. Each object in the array may optionally contain the recipient's name.
     * 
     * @maxItems 1000
     */
    bcc?: CCBCCEmailObject[]
    /**
     * The subject of your email. See character length requirements according to [RFC 2822](http://stackoverflow.com/questions/1592291/what-is-the-email-subject-length-limit#answer-1592310).
     */
    subject?: string
    /**
     * A collection of JSON key/value pairs allowing you to specify handling instructions for your email. You may not overwrite the following headers: `x-sg-id`, `x-sg-eid`, `received`, `dkim-signature`, `Content-Type`, `Content-Transfer-Encoding`, `To`, `From`, `Subject`, `Reply-To`, `CC`, `BCC`
     */
    headers?: {

    }
    /**
     * Substitutions allow you to insert data without using Dynamic Transactional Templates. This field should **not** be used in combination with a Dynamic Transactional Template, which can be identified by a `template_id` starting with `d-`. This field is a collection of key/value pairs following the pattern "substitution_tag":"value to substitute". The key/value pairs must be strings. These substitutions will apply to the text and html content of the body of your email, in addition to the `subject` and `reply-to` parameters. The total collective size of your substitutions may not exceed 10,000 bytes per personalization object.
     */
    substitutions?: {

    }
    /**
     * Dynamic template data is available using Handlebars syntax in Dynamic Transactional Templates. This field should be used in combination with a Dynamic Transactional Template, which can be identified by a `template_id` starting with `d-`. This field is a collection of key/value pairs following the pattern "variable_name":"value to insert".
     */
    dynamic_template_data?: {

    }
    /**
     * Values that are specific to this personalization that will be carried along with the email and its activity data. Substitutions will not be made on custom arguments, so any string that is entered into this parameter will be assumed to be the custom argument that you would like to be used. This field may not exceed 10,000 bytes.
     */
    custom_args?: {

    }
    /**
     * A unix timestamp allowing you to specify when your email should be delivered. Scheduling delivery more than 72 hours in advance is forbidden.
     */
    send_at?: number
  }[]
  from: FromEmailObject
  reply_to?: ReplyToEmailObject
  /**
   * An array of recipients who will receive replies and/or bounces. Each object in this array must contain the recipient's email address. Each object in the array may optionally contain the recipient's name. You can either choose to use “reply_to” field or “reply_to_list” but not both.
   * 
   * @maxItems 1000
   */
  reply_to_list?: {
    /**
     * The email address where any replies or bounces will be returned.
     */
    email: string
    /**
     * A name or title associated with the `reply_to_list` email address.
     */
    name?: string
  }[]
  /**
   * The global or 'message level' subject of your email. This may be overridden by subject lines set in personalizations.
   */
  subject: string
  /**
   * An array where you can specify the content of your email. You can include multiple [MIME types](https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types) of content, but you must specify at least one MIME type. To include more than one MIME type, add another object to the array containing the `type` and `value` parameters.
   */
  content: {
    /**
     * The MIME type of the content you are including in your email (e.g., `“text/plain”` or `“text/html”`).
     */
    type: string
    /**
     * The actual content of the specified MIME type that you are including in your email.
     */
    value: string
  }[]
  /**
   * An array of objects where you can specify any attachments you want to include.
   */
  attachments?: {
    /**
     * The Base64 encoded content of the attachment.
     */
    content: string
    /**
     * The MIME type of the content you are attaching (e.g., `“text/plain”` or `“text/html”`).
     */
    type?: string
    /**
     * The attachment's filename.
     */
    filename: string
    /**
     * The attachment's content-disposition, specifying how you would like the attachment to be displayed. For example, `“inline”` results in the attached file are displayed automatically within the message while `“attachment”` results in the attached file require some action to be taken before it is displayed, such as opening or downloading the file.
     */
    disposition?: ("inline" | "attachment")
    /**
     * The attachment's content ID. This is used when the disposition is set to `“inline”` and the attachment is an image, allowing the file to be displayed within the body of your email.
     */
    content_id?: string
  }[]
  /**
   * An email template ID. A template that contains a subject and content — either text or html — will override any subject and content values specified at the personalizations or message level.
   */
  template_id?: string
  /**
   * An object containing key/value pairs of header names and the value to substitute for them. The key/value pairs must be strings. You must ensure these are properly encoded if they contain unicode characters. These headers cannot be one of the reserved headers.
   */
  headers?: {

  }
  /**
   * An array of category names for this message. Each category name may not exceed 255 characters. 
   * 
   * @maxItems 10
   */
  categories?: [] | [string] | [string, string] | [string, string, string] | [string, string, string, string] | [string, string, string, string, string] | [string, string, string, string, string, string] | [string, string, string, string, string, string, string] | [string, string, string, string, string, string, string, string] | [string, string, string, string, string, string, string, string, string] | [string, string, string, string, string, string, string, string, string, string]
  /**
   * Values that are specific to the entire send that will be carried along with the email and its activity data.  Key/value pairs must be strings. Substitutions will not be made on custom arguments, so any string that is entered into this parameter will be assumed to be the custom argument that you would like to be used. This parameter is overridden by `custom_args` set at the personalizations level. Total `custom_args` size may not exceed 10,000 bytes.
   */
  custom_args?: string
  /**
   * A unix timestamp allowing you to specify when you want your email to be delivered. This may be overridden by the `send_at` parameter set at the personalizations level. Delivery cannot be scheduled more than 72 hours in advance. If you have the flexibility, it's better to schedule mail for off-peak times. Most emails are scheduled and sent at the top of the hour or half hour. Scheduling email to avoid peak times — for example, scheduling at 10:53 — can result in lower deferral rates due to the reduced traffic during off-peak times.
   */
  send_at?: number
  /**
   * An ID representing a batch of emails to be sent at the same time. Including a `batch_id` in your request allows you include this email in that batch. It also enables you to cancel or pause the delivery of that batch. For more information, see the [Cancel Scheduled Sends API](https://sendgrid.com/docs/api-reference/).
   */
  batch_id?: string
  /**
   * An object allowing you to specify how to handle unsubscribes.
   */
  asm?: {
    /**
     * The unsubscribe group to associate with this email.
     */
    group_id: number
    /**
     * An array containing the unsubscribe groups that you would like to be displayed on the unsubscribe preferences page.
     * 
     * @maxItems 25
     */
    groups_to_display?: number[]
  }
  /**
   * The IP Pool that you would like to send this email from.
   */
  ip_pool_name?: string
  /**
   * A collection of different mail settings that you can use to specify how you would like this email to be handled.
   */
  mail_settings?: {
    /**
     * Allows you to bypass all unsubscribe groups and suppressions to ensure that the email is delivered to every single recipient. This should only be used in emergencies when it is absolutely necessary that every recipient receives your email. This filter cannot be combined with any other bypass filters. See our [documentation](https://sendgrid.com/docs/ui/sending-email/index-suppressions/#bypass-suppressions) for more about bypass filters.
     */
    bypass_list_management?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
    }
    /**
     * Allows you to bypass the spam report list to ensure that the email is delivered to recipients. Bounce and unsubscribe lists will still be checked; addresses on these other lists will not receive the message. This filter cannot be combined with the `bypass_list_management` filter. See our [documentation](https://sendgrid.com/docs/ui/sending-email/index-suppressions/#bypass-suppressions) for more about bypass filters.
     */
    bypass_spam_management?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
    }
    /**
     * Allows you to bypass the bounce list to ensure that the email is delivered to recipients. Spam report and unsubscribe lists will still be checked; addresses on these other lists will not receive the message. This filter cannot be combined with the `bypass_list_management` filter. See our [documentation](https://sendgrid.com/docs/ui/sending-email/index-suppressions/#bypass-suppressions) for more about bypass filters.
     */
    bypass_bounce_management?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
    }
    /**
     * Allows you to bypass the global unsubscribe list to ensure that the email is delivered to recipients. Bounce and spam report lists will still be checked; addresses on these other lists will not receive the message. This filter applies only to global unsubscribes and will not bypass group unsubscribes. This filter cannot be combined with the `bypass_list_management` filter. See our [documentation](https://sendgrid.com/docs/ui/sending-email/index-suppressions/#bypass-suppressions) for more about bypass filters.
     */
    bypass_unsubscribe_management?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
    }
    /**
     * The default footer that you would like included on every email.
     */
    footer?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
      /**
       * The plain text content of your footer.
       */
      text?: string
      /**
       * The HTML content of your footer.
       */
      html?: string
    }
    /**
     * Sandbox Mode allows you to send a test email to ensure that your request body is valid and formatted correctly.
     */
    sandbox_mode?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
    }
  }
  /**
   * Settings to determine how you would like to track the metrics of how your recipients interact with your email.
   */
  tracking_settings?: {
    /**
     * Allows you to track if a recipient clicked a link in your email.
     */
    click_tracking?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
      /**
       * Indicates if this setting should be included in the `text/plain` portion of your email.
       */
      enable_text?: boolean
    }
    /**
     * Allows you to track if the email was opened by including a single pixel image in the body of the content. When the pixel is loaded, Twilio SendGrid can log that the email was opened.
     */
    open_tracking?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
      /**
       * Allows you to specify a substitution tag that you can insert in the body of your email at a location that you desire. This tag will be replaced by the open tracking pixel.
       */
      substitution_tag?: string
    }
    /**
     * Allows you to insert a subscription management link at the bottom of the text and HTML bodies of your email. If you would like to specify the location of the link within your email, you may use the `substitution_tag`.
     */
    subscription_tracking?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
      /**
       * Text to be appended to the email with the subscription tracking link. You may control where the link is by using the tag <% %>
       */
      text?: string
      /**
       * HTML to be appended to the email with the subscription tracking link. You may control where the link is by using the tag <% %>
       */
      html?: string
      /**
       * A tag that will be replaced with the unsubscribe URL. for example: `[unsubscribe_url]`. If this parameter is used, it will override both the `text` and `html` parameters. The URL of the link will be placed at the substitution tag’s location with no additional formatting.
       */
      substitution_tag?: string
    }
    /**
     * Allows you to enable tracking provided by Google Analytics.
     */
    ganalytics?: {
      /**
       * Indicates if this setting is enabled.
       */
      enable?: boolean
      /**
       * Name of the referrer source. (e.g. Google, SomeDomain.com, or Marketing Email)
       */
      utm_source?: string
      /**
       * Name of the marketing medium. (e.g. Email)
       */
      utm_medium?: string
      /**
       * Used to identify any paid keywords.
       */
      utm_term?: string
      /**
       * Used to differentiate your campaign from advertisements.
       */
      utm_content?: string
      /**
       * The name of the campaign.
       */
      utm_campaign?: string
    }
  }
}
export interface FromEmailObject {
  /**
   * The 'From' email address used to deliver the message. This address should be a verified sender in your Twilio SendGrid account.
   */
  email: string
  /**
   * A name or title associated with the sending email address.
   */
  name?: string
}
export interface CCBCCEmailObject {
  /**
   * The intended recipient's email address.
   */
  email: string
  /**
   * The intended recipient's name.
   */
  name?: string
}
export interface ReplyToEmailObject {
  /**
   * The email address where any replies or bounces will be returned.
   */
  email: string
  /**
   * A name or title associated with the `reply_to` email address.
   */
  name?: string
}
export interface MarketingContactsInput {
  /**
   * An array of List ID strings that this contact will be added to.
   */
  list_ids?: string[]
  /**
   * One or more contacts objects that you intend to upsert. The available fields for a contact, including the required `email` field are described below.
   * 
   * @minItems 1
   * @maxItems 30000
   */
  contacts: [ContactRequest, ...(ContactRequest)[]]
}
export interface ContactRequest {
  /**
   * The first line of the address.
   */
  address_line_1?: string
  /**
   * An optional second line for the address.
   */
  address_line_2?: string
  /**
   * Additional emails associated with the contact.
   * 
   * @minItems 0
   * @maxItems 5
   */
  alternate_emails?: [] | [string] | [string, string] | [string, string, string] | [string, string, string, string] | [string, string, string, string, string]
  /**
   * The contact's city.
   */
  city?: string
  /**
   * The contact's country. Can be a full name or an abbreviation.
   */
  country?: string
  /**
   * The contact's primary email. This is required to be a valid email.
   */
  email: string
  /**
   * The contact's personal name.
   */
  first_name?: string
  /**
   * The contact's family name.
   */
  last_name?: string
  /**
   * The contact's ZIP code or other postal code.
   */
  postal_code?: string
  /**
   * The contact's state, province, or region.
   */
  state_province_region?: string
  custom_fields?: CustomFieldsById
}
export interface CustomFieldsById {
  [k: string]: unknown
}
export interface MarketingContactsOutput {
  /**
   * Indicates that the contacts are queued for processing. Check the job status with the "Import Contacts Status" endpoint.
   */
  job_id?: string
}
