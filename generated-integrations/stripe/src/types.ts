export type StripeTypes = CheckoutSessionCompletedOutput
/**
 * A list of [file links](https://stripe.com/docs/api#file_links) that point at this file.
 */
export type FileFileLinkList = ({
  /**
   * Details about each object.
   */
  data: FileLink[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
} | null)
export type Polymorphic = (BankAccount | Card)
/**
 * A list of refunds that have been applied to the charge.
 */
export type RefundList = ({
  /**
   * Details about each object.
   */
  data: Refund[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
} | null)
export type Polymorphic1 = (BankAccount | Card | Source)

/**
 * A Checkout Session represents your customer's session as they pay for
 * one-time purchases or subscriptions through [Checkout](https://stripe.com/docs/payments/checkout)
 * or [Payment Links](https://stripe.com/docs/payments/payment-links). We recommend creating a
 * new Session each time your customer attempts to pay.
 * 
 * Once payment is successful, the Checkout Session will contain a reference
 * to the [Customer](https://stripe.com/docs/api/customers), and either the successful
 * [PaymentIntent](https://stripe.com/docs/api/payment_intents) or an active
 * [Subscription](https://stripe.com/docs/api/subscriptions).
 * 
 * You can create a Checkout Session on your server and redirect to its URL
 * to begin Checkout.
 * 
 * Related guide: [Checkout Quickstart](https://stripe.com/docs/checkout/quickstart).
 */
export interface CheckoutSessionCompletedOutput {
  /**
   * When set, provides configuration for actions to take if this Checkout Session expires.
   */
  after_expiration?: (PaymentPagesCheckoutSessionAfterExpiration | null)
  /**
   * Enables user redeemable promotion codes.
   */
  allow_promotion_codes?: (boolean | null)
  /**
   * Total of all items before discounts or taxes are applied.
   */
  amount_subtotal?: (number | null)
  /**
   * Total of all items after discounts and taxes are applied.
   */
  amount_total?: (number | null)
  automatic_tax: PaymentPagesCheckoutSessionAutomaticTax
  /**
   * Describes whether Checkout should collect the customer's billing address.
   */
  billing_address_collection?: ("auto" | "required" | null)
  /**
   * If set, Checkout displays a back button and customers will be directed to this URL if they decide to cancel payment and return to your website.
   */
  cancel_url?: (string | null)
  /**
   * A unique string to reference the Checkout Session. This can be a
   * customer ID, a cart ID, or similar, and can be used to reconcile the
   * Session with your internal systems.
   */
  client_reference_id?: (string | null)
  /**
   * Results of `consent_collection` for this session.
   */
  consent?: (PaymentPagesCheckoutSessionConsent | null)
  /**
   * When set, provides configuration for the Checkout Session to gather active consent from customers.
   */
  consent_collection?: (PaymentPagesCheckoutSessionConsentCollection | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency?: (string | null)
  /**
   * Collect additional information from your customer using custom fields. Up to 2 fields are supported.
   */
  custom_fields: PaymentPagesCheckoutSessionCustomFields[]
  custom_text: PaymentPagesCheckoutSessionCustomText
  /**
   * The ID of the customer for this Session.
   * For Checkout Sessions in `payment` or `subscription` mode, Checkout
   * will create a new customer object based on information provided
   * during the payment flow unless an existing customer was provided when
   * the Session was created.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * Configure whether a Checkout Session creates a Customer when the Checkout Session completes.
   */
  customer_creation?: ("always" | "if_required" | null)
  /**
   * The customer details including the customer's tax exempt status and the customer's tax IDs. Only the customer's email is present on Sessions in `setup` mode.
   */
  customer_details?: (PaymentPagesCheckoutSessionCustomerDetails | null)
  /**
   * If provided, this value will be used when the Customer object is created.
   * If not provided, customers will be asked to enter their email address.
   * Use this parameter to prefill customer data if you already have an email
   * on file. To access information about the customer once the payment flow is
   * complete, use the `customer` attribute.
   */
  customer_email?: (string | null)
  /**
   * The timestamp at which the Checkout Session will expire.
   */
  expires_at: number
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * ID of the invoice created by the Checkout Session, if it exists.
   */
  invoice?: (string | Invoice | null)
  /**
   * Details on the state of invoice creation for the Checkout Session.
   */
  invoice_creation?: (PaymentPagesCheckoutSessionInvoiceCreation | null)
  line_items?: PaymentPagesCheckoutSessionListLineItems
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * The IETF language tag of the locale Checkout is displayed in. If blank or `auto`, the browser's locale is used.
   */
  locale?: ("auto" | "bg" | "cs" | "da" | "de" | "el" | "en" | "en-GB" | "es" | "es-419" | "et" | "fi" | "fil" | "fr" | "fr-CA" | "hr" | "hu" | "id" | "it" | "ja" | "ko" | "lt" | "lv" | "ms" | "mt" | "nb" | "nl" | "pl" | "pt" | "pt-BR" | "ro" | "ru" | "sk" | "sl" | "sv" | "th" | "tr" | "vi" | "zh" | "zh-HK" | "zh-TW" | null)
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * The mode of the Checkout Session.
   */
  mode: ("payment" | "setup" | "subscription")
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "checkout.session"
  /**
   * The ID of the PaymentIntent for Checkout Sessions in `payment` mode.
   */
  payment_intent?: (string | PaymentIntent | null)
  /**
   * The ID of the Payment Link that created this Session.
   */
  payment_link?: (string | PaymentLink | null)
  /**
   * Configure whether a Checkout Session should collect a payment method.
   */
  payment_method_collection?: ("always" | "if_required" | null)
  /**
   * Payment-method-specific configuration for the PaymentIntent or SetupIntent of this CheckoutSession.
   */
  payment_method_options?: (CheckoutSessionPaymentMethodOptions | null)
  /**
   * A list of the types of payment methods (e.g. card) this Checkout
   * Session is allowed to accept.
   */
  payment_method_types: string[]
  /**
   * The payment status of the Checkout Session, one of `paid`, `unpaid`, or `no_payment_required`.
   * You can use this value to decide when to fulfill your customer's order.
   */
  payment_status: ("no_payment_required" | "paid" | "unpaid")
  phone_number_collection?: PaymentPagesCheckoutSessionPhoneNumberCollection
  /**
   * The ID of the original expired Checkout Session that triggered the recovery flow.
   */
  recovered_from?: (string | null)
  /**
   * The ID of the SetupIntent for Checkout Sessions in `setup` mode.
   */
  setup_intent?: (string | SetupIntent | null)
  /**
   * When set, provides configuration for Checkout to collect a shipping address from a customer.
   */
  shipping_address_collection?: (PaymentPagesCheckoutSessionShippingAddressCollection | null)
  /**
   * The details of the customer cost of shipping, including the customer chosen ShippingRate.
   */
  shipping_cost?: (PaymentPagesCheckoutSessionShippingCost | null)
  /**
   * Shipping information for this Checkout Session.
   */
  shipping_details?: (Shipping | null)
  /**
   * The shipping rate options applied to this Session.
   */
  shipping_options: PaymentPagesCheckoutSessionShippingOption[]
  /**
   * The status of the Checkout Session, one of `open`, `complete`, or `expired`.
   */
  status?: ("complete" | "expired" | "open" | null)
  /**
   * Describes the type of transaction being performed by Checkout in order to customize
   * relevant text on the page, such as the submit button. `submit_type` can only be
   * specified on Checkout Sessions in `payment` mode, but not Checkout Sessions
   * in `subscription` or `setup` mode.
   */
  submit_type?: ("auto" | "book" | "donate" | "pay" | null)
  /**
   * The ID of the subscription for Checkout Sessions in `subscription` mode.
   */
  subscription?: (string | Subscription | null)
  /**
   * The URL the customer will be directed to after the payment or
   * subscription creation is successful.
   */
  success_url: string
  tax_id_collection?: PaymentPagesCheckoutSessionTaxIDCollection
  /**
   * Tax and discount details for the computed total amount.
   */
  total_details?: (PaymentPagesCheckoutSessionTotalDetails | null)
  /**
   * The URL to the Checkout Session. Redirect customers to this URL to take them to Checkout. If you’re using [Custom Domains](https://stripe.com/docs/payments/checkout/custom-domains), the URL will use your subdomain. Otherwise, it’ll use `checkout.stripe.com.`
   * This value is only present when the session is active.
   */
  url?: (string | null)
}
export interface PaymentPagesCheckoutSessionAfterExpiration {
  /**
   * When set, configuration used to recover the Checkout Session on expiry.
   */
  recovery?: (PaymentPagesCheckoutSessionAfterExpirationRecovery | null)
}
export interface PaymentPagesCheckoutSessionAfterExpirationRecovery {
  /**
   * Enables user redeemable promotion codes on the recovered Checkout Sessions. Defaults to `false`
   */
  allow_promotion_codes: boolean
  /**
   * If `true`, a recovery url will be generated to recover this Checkout Session if it
   * expires before a transaction is completed. It will be attached to the
   * Checkout Session object upon expiration.
   */
  enabled: boolean
  /**
   * The timestamp at which the recovery URL will expire.
   */
  expires_at?: (number | null)
  /**
   * URL that creates a new Checkout Session when clicked that is a copy of this expired Checkout Session
   */
  url?: (string | null)
}
export interface PaymentPagesCheckoutSessionAutomaticTax {
  /**
   * Indicates whether automatic tax is enabled for the session
   */
  enabled: boolean
  /**
   * The status of the most recent automated tax calculation for this session.
   */
  status?: ("complete" | "failed" | "requires_location_inputs" | null)
}
export interface PaymentPagesCheckoutSessionConsent {
  /**
   * If `opt_in`, the customer consents to receiving promotional communications
   * from the merchant about this Checkout Session.
   */
  promotions?: ("opt_in" | "opt_out" | null)
  /**
   * If `accepted`, the customer in this Checkout Session has agreed to the merchant's terms of service.
   */
  terms_of_service?: ("accepted" | null)
}
export interface PaymentPagesCheckoutSessionConsentCollection {
  /**
   * If set to `auto`, enables the collection of customer consent for promotional communications. The Checkout
   * Session will determine whether to display an option to opt into promotional communication
   * from the merchant depending on the customer's locale. Only available to US merchants.
   */
  promotions?: ("auto" | "none" | null)
  /**
   * If set to `required`, it requires customers to accept the terms of service before being able to pay.
   */
  terms_of_service?: ("none" | "required" | null)
}
export interface PaymentPagesCheckoutSessionCustomFields {
  /**
   * Configuration for `type=dropdown` fields.
   */
  dropdown?: (PaymentPagesCheckoutSessionCustomFieldsDropdown | null)
  /**
   * String of your choice that your integration can use to reconcile this field. Must be unique to this field, alphanumeric, and up to 200 characters.
   */
  key: string
  label: PaymentPagesCheckoutSessionCustomFieldsLabel
  /**
   * Configuration for `type=numeric` fields.
   */
  numeric?: (PaymentPagesCheckoutSessionCustomFieldsNumeric | null)
  /**
   * Whether the customer is required to complete the field before completing the Checkout Session. Defaults to `false`.
   */
  optional: boolean
  /**
   * Configuration for `type=text` fields.
   */
  text?: (PaymentPagesCheckoutSessionCustomFieldsText | null)
  /**
   * The type of the field.
   */
  type: ("dropdown" | "numeric" | "text")
}
export interface PaymentPagesCheckoutSessionCustomFieldsDropdown {
  /**
   * The options available for the customer to select. Up to 200 options allowed.
   */
  options: PaymentPagesCheckoutSessionCustomFieldsOption[]
  /**
   * The option selected by the customer. This will be the `value` for the option.
   */
  value?: (string | null)
}
export interface PaymentPagesCheckoutSessionCustomFieldsOption {
  /**
   * The label for the option, displayed to the customer. Up to 100 characters.
   */
  label: string
  /**
   * The value for this option, not displayed to the customer, used by your integration to reconcile the option selected by the customer. Must be unique to this option, alphanumeric, and up to 100 characters.
   */
  value: string
}
export interface PaymentPagesCheckoutSessionCustomFieldsLabel {
  /**
   * Custom text for the label, displayed to the customer. Up to 50 characters.
   */
  custom?: (string | null)
  /**
   * The type of the label.
   */
  type: "custom"
}
export interface PaymentPagesCheckoutSessionCustomFieldsNumeric {
  /**
   * The value entered by the customer, containing only digits.
   */
  value?: (string | null)
}
export interface PaymentPagesCheckoutSessionCustomFieldsText {
  /**
   * The value entered by the customer.
   */
  value?: (string | null)
}
export interface PaymentPagesCheckoutSessionCustomText {
  /**
   * Custom text that should be displayed alongside shipping address collection.
   */
  shipping_address?: (PaymentPagesCheckoutSessionCustomTextPosition | null)
  /**
   * Custom text that should be displayed alongside the payment confirmation button.
   */
  submit?: (PaymentPagesCheckoutSessionCustomTextPosition | null)
}
export interface PaymentPagesCheckoutSessionCustomTextPosition {
  /**
   * Text may be up to 1000 characters in length.
   */
  message: string
}
/**
 * This object represents a customer of your business. It lets you create recurring charges and track payments that belong to the same customer.
 * 
 * Related guide: [Save a card during payment](https://stripe.com/docs/payments/save-during-payment).
 */
export interface Customer {
  /**
   * The customer's address.
   */
  address?: (Address | null)
  /**
   * Current balance, if any, being stored on the customer. If negative, the customer has credit to apply to their next invoice. If positive, the customer has an amount owed that will be added to their next invoice. The balance does not refer to any unpaid invoices; it solely takes into account amounts that have yet to be successfully applied to any invoice. This balance is only taken into account as invoices are finalized.
   */
  balance?: number
  /**
   * The current funds being held by Stripe on behalf of the customer. These funds can be applied towards payment intents with source "cash_balance". The settings[reconciliation_mode] field describes whether these funds are applied to such payment intents manually or automatically.
   */
  cash_balance?: (CashBalance | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO code for the currency](https://stripe.com/docs/currencies) the customer can be charged in for recurring billing purposes.
   */
  currency?: (string | null)
  /**
   * ID of the default payment source for the customer.
   * 
   * If you are using payment methods created via the PaymentMethods API, see the [invoice_settings.default_payment_method](https://stripe.com/docs/api/customers/object#customer_object-invoice_settings-default_payment_method) field instead.
   */
  default_source?: (string | BankAccount | Card | Source | null)
  /**
   * When the customer's latest invoice is billed by charging automatically, `delinquent` is `true` if the invoice's latest charge failed. When the customer's latest invoice is billed by sending an invoice, `delinquent` is `true` if the invoice isn't paid by its due date.
   * 
   * If an invoice is marked uncollectible by [dunning](https://stripe.com/docs/billing/automatic-collection), `delinquent` doesn't get reset to `false`.
   */
  delinquent?: (boolean | null)
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * Describes the current discount active on the customer, if there is one.
   */
  discount?: (Discount | null)
  /**
   * The customer's email address.
   */
  email?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The current multi-currency balances, if any, being stored on the customer. If positive in a currency, the customer has a credit to apply to their next invoice denominated in that currency. If negative, the customer has an amount owed that will be added to their next invoice denominated in that currency. These balances do not refer to any unpaid invoices. They solely track amounts that have yet to be successfully applied to any invoice. A balance in a particular currency is only applied to any invoice as an invoice in that currency is finalized.
   */
  invoice_credit_balance?: {
    [k: string]: number
  }
  /**
   * The prefix for the customer used to generate unique invoice numbers.
   */
  invoice_prefix?: (string | null)
  invoice_settings?: InvoiceSettingCustomerSetting
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: {
    [k: string]: string
  }
  /**
   * The customer's full name or business name.
   */
  name?: (string | null)
  /**
   * The suffix of the customer's next invoice number, e.g., 0001.
   */
  next_invoice_sequence?: number
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "customer"
  /**
   * The customer's phone number.
   */
  phone?: (string | null)
  /**
   * The customer's preferred locales (languages), ordered by preference.
   */
  preferred_locales?: (string[] | null)
  /**
   * Mailing and shipping address for the customer. Appears on invoices emailed to this customer.
   */
  shipping?: (Shipping | null)
  sources?: ApmsSourcesSourceList
  subscriptions?: SubscriptionList
  tax?: CustomerTax
  /**
   * Describes the customer's tax exemption status. One of `none`, `exempt`, or `reverse`. When set to `reverse`, invoice and receipt PDFs include the text **"Reverse charge"**.
   */
  tax_exempt?: ("exempt" | "none" | "reverse" | null)
  tax_ids?: TaxIDsList
  /**
   * ID of the test clock this customer belongs to.
   */
  test_clock?: (string | TestClock | null)
}
export interface Address {
  /**
   * City, district, suburb, town, or village.
   */
  city?: (string | null)
  /**
   * Two-letter country code ([ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2)).
   */
  country?: (string | null)
  /**
   * Address line 1 (e.g., street, PO Box, or company name).
   */
  line1?: (string | null)
  /**
   * Address line 2 (e.g., apartment, suite, unit, or building).
   */
  line2?: (string | null)
  /**
   * ZIP or postal code.
   */
  postal_code?: (string | null)
  /**
   * State, county, province, or region.
   */
  state?: (string | null)
}
/**
 * A customer's `Cash balance` represents real funds. Customers can add funds to their cash balance by sending a bank transfer. These funds can be used for payment and can eventually be paid out to your bank account.
 */
export interface CashBalance {
  /**
   * A hash of all cash balances available to this customer. You cannot delete a customer with any cash balances, even if the balance is 0. Amounts are represented in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  available?: ({
    [k: string]: number
  } | null)
  /**
   * The ID of the customer whose cash balance this object represents.
   */
  customer: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "cash_balance"
  settings: CustomerBalanceCustomerBalanceSettings
}
export interface CustomerBalanceCustomerBalanceSettings {
  /**
   * The configuration for how funds that land in the customer cash balance are reconciled.
   */
  reconciliation_mode: ("automatic" | "manual")
  /**
   * A flag to indicate if reconciliation mode returned is the user's default or is specific to this customer cash balance
   */
  using_merchant_default: boolean
}
/**
 * These bank accounts are payment methods on `Customer` objects.
 * 
 * On the other hand [External Accounts](https://stripe.com/docs/api#external_accounts) are transfer
 * destinations on `Account` objects for [Custom accounts](https://stripe.com/docs/connect/custom-accounts).
 * They can be bank accounts or debit cards as well, and are documented in the links above.
 * 
 * Related guide: [Bank Debits and Transfers](https://stripe.com/docs/payments/bank-debits-transfers).
 */
export interface BankAccount {
  /**
   * The ID of the account that the bank account is associated with.
   */
  account?: (string | Account | null)
  /**
   * The name of the person or business that owns the bank account.
   */
  account_holder_name?: (string | null)
  /**
   * The type of entity that holds the account. This can be either `individual` or `company`.
   */
  account_holder_type?: (string | null)
  /**
   * The bank account type. This can only be `checking` or `savings` in most countries. In Japan, this can only be `futsu` or `toza`.
   */
  account_type?: (string | null)
  /**
   * A set of available payout methods for this bank account. Only values from this set should be passed as the `method` when creating a payout.
   */
  available_payout_methods?: (("instant" | "standard")[] | null)
  /**
   * Name of the bank associated with the routing number (e.g., `WELLS FARGO`).
   */
  bank_name?: (string | null)
  /**
   * Two-letter ISO code representing the country the bank account is located in.
   */
  country: string
  /**
   * Three-letter [ISO code for the currency](https://stripe.com/docs/payouts) paid out to the bank account.
   */
  currency: string
  /**
   * The ID of the customer that the bank account is associated with.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * Whether this bank account is the default external account for its currency.
   */
  default_for_currency?: (boolean | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The last four digits of the bank account number.
   */
  last4: string
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "bank_account"
  /**
   * The routing transit number for the bank account.
   */
  routing_number?: (string | null)
  /**
   * For bank accounts, possible values are `new`, `validated`, `verified`, `verification_failed`, or `errored`. A bank account that hasn't had any activity or validation performed is `new`. If Stripe can determine that the bank account exists, its status will be `validated`. Note that there often isn’t enough information to know (e.g., for smaller credit unions), and the validation is not always run. If customer bank account verification has succeeded, the bank account status will be `verified`. If the verification failed for any reason, such as microdeposit failure, the status will be `verification_failed`. If a transfer sent to this bank account fails, we'll set the status to `errored` and will not continue to send transfers until the bank details are updated.
   * 
   * For external accounts, possible values are `new` and `errored`. Validations aren't run against external accounts because they're only used for payouts. This means the other statuses don't apply. If a transfer fails, the status is set to `errored` and transfers are stopped until account details are updated.
   */
  status: string
}
/**
 * This is an object representing a Stripe account. You can retrieve it to see
 * properties on the account like its current requirements or if the account is
 * enabled to make live charges or receive payouts.
 * 
 * For Custom accounts, the properties below are always returned. For other accounts, some properties are returned until that
 * account has started to go through Connect Onboarding. Once you create an [Account Link](https://stripe.com/docs/api/account_links)
 * for a Standard or Express account, some parameters are no longer returned. These are marked as **Custom Only** or **Custom and Express**
 * below. Learn about the differences [between accounts](https://stripe.com/docs/connect/accounts).
 */
export interface Account {
  /**
   * Business information about the account.
   */
  business_profile?: (AccountBusinessProfile | null)
  /**
   * The business type.
   */
  business_type?: ("company" | "government_entity" | "individual" | "non_profit" | null)
  capabilities?: AccountCapabilities
  /**
   * Whether the account can create live charges.
   */
  charges_enabled?: boolean
  company?: LegalEntityCompany
  controller?: AccountUnificationAccountController
  /**
   * The account's country.
   */
  country?: string
  /**
   * Time at which the account was connected. Measured in seconds since the Unix epoch.
   */
  created?: number
  /**
   * Three-letter ISO currency code representing the default currency for the account. This must be a currency that [Stripe supports in the account's country](https://stripe.com/docs/payouts).
   */
  default_currency?: string
  /**
   * Whether account details have been submitted. Standard accounts cannot receive payouts before this is true.
   */
  details_submitted?: boolean
  /**
   * An email address associated with the account. You can treat this as metadata: it is not used for authentication or messaging account holders.
   */
  email?: (string | null)
  external_accounts?: ExternalAccountList
  future_requirements?: AccountFutureRequirements
  /**
   * Unique identifier for the object.
   */
  id: string
  individual?: Person
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "account"
  /**
   * Whether Stripe can send payouts to this account.
   */
  payouts_enabled?: boolean
  requirements?: AccountRequirements
  /**
   * Options for customizing how the account functions within Stripe.
   */
  settings?: (AccountSettings | null)
  tos_acceptance?: AccountTOSAcceptance
  /**
   * The Stripe account type. Can be `standard`, `express`, or `custom`.
   */
  type?: ("custom" | "express" | "standard")
}
export interface AccountBusinessProfile {
  /**
   * [The merchant category code for the account](https://stripe.com/docs/connect/setting-mcc). MCCs are used to classify businesses based on the goods or services they provide.
   */
  mcc?: (string | null)
  /**
   * The customer-facing business name.
   */
  name?: (string | null)
  /**
   * Internal-only description of the product sold or service provided by the business. It's used by Stripe for risk and underwriting purposes.
   */
  product_description?: (string | null)
  /**
   * A publicly available mailing address for sending support issues to.
   */
  support_address?: (Address | null)
  /**
   * A publicly available email address for sending support issues to.
   */
  support_email?: (string | null)
  /**
   * A publicly available phone number to call with support issues.
   */
  support_phone?: (string | null)
  /**
   * A publicly available website for handling support issues.
   */
  support_url?: (string | null)
  /**
   * The business's publicly available website.
   */
  url?: (string | null)
}
export interface AccountCapabilities {
  /**
   * The status of the Canadian pre-authorized debits payments capability of the account, or whether the account can directly process Canadian pre-authorized debits charges.
   */
  acss_debit_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the Affirm capability of the account, or whether the account can directly process Affirm charges.
   */
  affirm_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the Afterpay Clearpay capability of the account, or whether the account can directly process Afterpay Clearpay charges.
   */
  afterpay_clearpay_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the BECS Direct Debit (AU) payments capability of the account, or whether the account can directly process BECS Direct Debit (AU) charges.
   */
  au_becs_debit_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the Bacs Direct Debits payments capability of the account, or whether the account can directly process Bacs Direct Debits charges.
   */
  bacs_debit_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the Bancontact payments capability of the account, or whether the account can directly process Bancontact charges.
   */
  bancontact_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the customer_balance payments capability of the account, or whether the account can directly process customer_balance charges.
   */
  bank_transfer_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the blik payments capability of the account, or whether the account can directly process blik charges.
   */
  blik_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the boleto payments capability of the account, or whether the account can directly process boleto charges.
   */
  boleto_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the card issuing capability of the account, or whether you can use Issuing to distribute funds on cards
   */
  card_issuing?: ("active" | "inactive" | "pending")
  /**
   * The status of the card payments capability of the account, or whether the account can directly process credit and debit card charges.
   */
  card_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the Cartes Bancaires payments capability of the account, or whether the account can directly process Cartes Bancaires card charges in EUR currency.
   */
  cartes_bancaires_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the EPS payments capability of the account, or whether the account can directly process EPS charges.
   */
  eps_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the FPX payments capability of the account, or whether the account can directly process FPX charges.
   */
  fpx_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the giropay payments capability of the account, or whether the account can directly process giropay charges.
   */
  giropay_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the GrabPay payments capability of the account, or whether the account can directly process GrabPay charges.
   */
  grabpay_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the iDEAL payments capability of the account, or whether the account can directly process iDEAL charges.
   */
  ideal_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the india_international_payments capability of the account, or whether the account can process international charges (non INR) in India.
   */
  india_international_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the JCB payments capability of the account, or whether the account (Japan only) can directly process JCB credit card charges in JPY currency.
   */
  jcb_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the Klarna payments capability of the account, or whether the account can directly process Klarna charges.
   */
  klarna_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the konbini payments capability of the account, or whether the account can directly process konbini charges.
   */
  konbini_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the legacy payments capability of the account.
   */
  legacy_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the link_payments capability of the account, or whether the account can directly process Link charges.
   */
  link_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the OXXO payments capability of the account, or whether the account can directly process OXXO charges.
   */
  oxxo_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the P24 payments capability of the account, or whether the account can directly process P24 charges.
   */
  p24_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the paynow payments capability of the account, or whether the account can directly process paynow charges.
   */
  paynow_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the promptpay payments capability of the account, or whether the account can directly process promptpay charges.
   */
  promptpay_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the SEPA Direct Debits payments capability of the account, or whether the account can directly process SEPA Direct Debits charges.
   */
  sepa_debit_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the Sofort payments capability of the account, or whether the account can directly process Sofort charges.
   */
  sofort_payments?: ("active" | "inactive" | "pending")
  /**
   * The status of the tax reporting 1099-K (US) capability of the account.
   */
  tax_reporting_us_1099_k?: ("active" | "inactive" | "pending")
  /**
   * The status of the tax reporting 1099-MISC (US) capability of the account.
   */
  tax_reporting_us_1099_misc?: ("active" | "inactive" | "pending")
  /**
   * The status of the transfers capability of the account, or whether your platform can transfer funds to the account.
   */
  transfers?: ("active" | "inactive" | "pending")
  /**
   * The status of the banking capability, or whether the account can have bank accounts.
   */
  treasury?: ("active" | "inactive" | "pending")
  /**
   * The status of the US bank account ACH payments capability of the account, or whether the account can directly process US bank account charges.
   */
  us_bank_account_ach_payments?: ("active" | "inactive" | "pending")
}
export interface LegalEntityCompany {
  address?: Address
  /**
   * The Kana variation of the company's primary address (Japan only).
   */
  address_kana?: (LegalEntityJapanAddress | null)
  /**
   * The Kanji variation of the company's primary address (Japan only).
   */
  address_kanji?: (LegalEntityJapanAddress | null)
  /**
   * Whether the company's directors have been provided. This Boolean will be `true` if you've manually indicated that all directors are provided via [the `directors_provided` parameter](https://stripe.com/docs/api/accounts/update#update_account-company-directors_provided).
   */
  directors_provided?: boolean
  /**
   * Whether the company's executives have been provided. This Boolean will be `true` if you've manually indicated that all executives are provided via [the `executives_provided` parameter](https://stripe.com/docs/api/accounts/update#update_account-company-executives_provided), or if Stripe determined that sufficient executives were provided.
   */
  executives_provided?: boolean
  /**
   * The company's legal name.
   */
  name?: (string | null)
  /**
   * The Kana variation of the company's legal name (Japan only).
   */
  name_kana?: (string | null)
  /**
   * The Kanji variation of the company's legal name (Japan only).
   */
  name_kanji?: (string | null)
  /**
   * Whether the company's owners have been provided. This Boolean will be `true` if you've manually indicated that all owners are provided via [the `owners_provided` parameter](https://stripe.com/docs/api/accounts/update#update_account-company-owners_provided), or if Stripe determined that sufficient owners were provided. Stripe determines ownership requirements using both the number of owners provided and their total percent ownership (calculated by adding the `percent_ownership` of each owner together).
   */
  owners_provided?: boolean
  /**
   * This hash is used to attest that the beneficial owner information provided to Stripe is both current and correct.
   */
  ownership_declaration?: (LegalEntityUBODeclaration | null)
  /**
   * The company's phone number (used for verification).
   */
  phone?: (string | null)
  /**
   * The category identifying the legal structure of the company or legal entity. See [Business structure](https://stripe.com/docs/connect/identity-verification#business-structure) for more details.
   */
  structure?: ("free_zone_establishment" | "free_zone_llc" | "government_instrumentality" | "governmental_unit" | "incorporated_non_profit" | "limited_liability_partnership" | "llc" | "multi_member_llc" | "private_company" | "private_corporation" | "private_partnership" | "public_company" | "public_corporation" | "public_partnership" | "single_member_llc" | "sole_establishment" | "sole_proprietorship" | "tax_exempt_government_instrumentality" | "unincorporated_association" | "unincorporated_non_profit")
  /**
   * Whether the company's business ID number was provided.
   */
  tax_id_provided?: boolean
  /**
   * The jurisdiction in which the `tax_id` is registered (Germany-based companies only).
   */
  tax_id_registrar?: string
  /**
   * Whether the company's business VAT number was provided.
   */
  vat_id_provided?: boolean
  /**
   * Information on the verification state of the company.
   */
  verification?: (LegalEntityCompanyVerification | null)
}
export interface LegalEntityJapanAddress {
  /**
   * City/Ward.
   */
  city?: (string | null)
  /**
   * Two-letter country code ([ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2)).
   */
  country?: (string | null)
  /**
   * Block/Building number.
   */
  line1?: (string | null)
  /**
   * Building details.
   */
  line2?: (string | null)
  /**
   * ZIP or postal code.
   */
  postal_code?: (string | null)
  /**
   * Prefecture.
   */
  state?: (string | null)
  /**
   * Town/cho-me.
   */
  town?: (string | null)
}
export interface LegalEntityUBODeclaration {
  /**
   * The Unix timestamp marking when the beneficial owner attestation was made.
   */
  date?: (number | null)
  /**
   * The IP address from which the beneficial owner attestation was made.
   */
  ip?: (string | null)
  /**
   * The user-agent string from the browser where the beneficial owner attestation was made.
   */
  user_agent?: (string | null)
}
export interface LegalEntityCompanyVerification {
  document: LegalEntityCompanyVerificationDocument
}
export interface LegalEntityCompanyVerificationDocument {
  /**
   * The back of a document returned by a [file upload](https://stripe.com/docs/api#create_file) with a `purpose` value of `additional_verification`.
   */
  back?: (string | File | null)
  /**
   * A user-displayable string describing the verification state of this document.
   */
  details?: (string | null)
  /**
   * One of `document_corrupt`, `document_expired`, `document_failed_copy`, `document_failed_greyscale`, `document_failed_other`, `document_failed_test_mode`, `document_fraudulent`, `document_incomplete`, `document_invalid`, `document_manipulated`, `document_not_readable`, `document_not_uploaded`, `document_type_not_supported`, or `document_too_large`. A machine-readable code specifying the verification state for this document.
   */
  details_code?: (string | null)
  /**
   * The front of a document returned by a [file upload](https://stripe.com/docs/api#create_file) with a `purpose` value of `additional_verification`.
   */
  front?: (string | File | null)
}
/**
 * This is an object representing a file hosted on Stripe's servers. The
 * file may have been uploaded by yourself using the [create file](https://stripe.com/docs/api#create_file)
 * request (for example, when uploading dispute evidence) or it may have
 * been created by Stripe (for example, the results of a [Sigma scheduled
 * query](#scheduled_queries)).
 * 
 * Related guide: [File Upload Guide](https://stripe.com/docs/file-upload).
 */
export interface File {
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * The time at which the file expires and is no longer available in epoch seconds.
   */
  expires_at?: (number | null)
  /**
   * A filename for the file, suitable for saving to a filesystem.
   */
  filename?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  links?: FileFileLinkList
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "file"
  /**
   * The [purpose](https://stripe.com/docs/file-upload#uploading-a-file) of the uploaded file.
   */
  purpose: ("account_requirement" | "additional_verification" | "business_icon" | "business_logo" | "customer_signature" | "dispute_evidence" | "document_provider_identity_document" | "finance_report_run" | "identity_document" | "identity_document_downloadable" | "pci_document" | "selfie" | "sigma_scheduled_query" | "tax_document_user_upload" | "terminal_reader_splashscreen")
  /**
   * The size in bytes of the file object.
   */
  size: number
  /**
   * A user friendly title for the document.
   */
  title?: (string | null)
  /**
   * The type of the file returned (e.g., `csv`, `pdf`, `jpg`, or `png`).
   */
  type?: (string | null)
  /**
   * The URL from which the file can be downloaded using your live secret API key.
   */
  url?: (string | null)
}
/**
 * To share the contents of a `File` object with non-Stripe users, you can
 * create a `FileLink`. `FileLink`s contain a URL that can be used to
 * retrieve the contents of the file without authentication.
 */
export interface FileLink {
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Whether this link is already expired.
   */
  expired: boolean
  /**
   * Time at which the link expires.
   */
  expires_at?: (number | null)
  /**
   * The file object this link points to.
   */
  file: (string | File)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "file_link"
  /**
   * The publicly accessible URL to download the file.
   */
  url?: (string | null)
}
export interface AccountUnificationAccountController {
  /**
   * `true` if the Connect application retrieving the resource controls the account and can therefore exercise [platform controls](https://stripe.com/docs/connect/platform-controls-for-standard-accounts). Otherwise, this field is null.
   */
  is_controller?: boolean
  /**
   * The controller type. Can be `application`, if a Connect application controls the account, or `account`, if the account controls itself.
   */
  type: ("account" | "application")
}
/**
 * External accounts (bank accounts and debit cards) currently attached to this account
 */
export interface ExternalAccountList {
  /**
   * The list contains all external accounts that have been attached to the Stripe account. These may be bank accounts or cards.
   */
  data: Polymorphic[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
/**
 * You can store multiple cards on a customer in order to charge the customer
 * later. You can also store multiple debit cards on a recipient in order to
 * transfer to those cards later.
 * 
 * Related guide: [Card Payments with Sources](https://stripe.com/docs/sources/cards).
 */
export interface Card {
  /**
   * The account this card belongs to. This attribute will not be in the card object if the card belongs to a customer or recipient instead.
   */
  account?: (string | Account | null)
  /**
   * City/District/Suburb/Town/Village.
   */
  address_city?: (string | null)
  /**
   * Billing address country, if provided when creating card.
   */
  address_country?: (string | null)
  /**
   * Address line 1 (Street address/PO Box/Company name).
   */
  address_line1?: (string | null)
  /**
   * If `address_line1` was provided, results of the check: `pass`, `fail`, `unavailable`, or `unchecked`.
   */
  address_line1_check?: (string | null)
  /**
   * Address line 2 (Apartment/Suite/Unit/Building).
   */
  address_line2?: (string | null)
  /**
   * State/County/Province/Region.
   */
  address_state?: (string | null)
  /**
   * ZIP or postal code.
   */
  address_zip?: (string | null)
  /**
   * If `address_zip` was provided, results of the check: `pass`, `fail`, `unavailable`, or `unchecked`.
   */
  address_zip_check?: (string | null)
  /**
   * A set of available payout methods for this card. Only values from this set should be passed as the `method` when creating a payout.
   */
  available_payout_methods?: (("instant" | "standard")[] | null)
  /**
   * Card brand. Can be `American Express`, `Diners Club`, `Discover`, `JCB`, `MasterCard`, `UnionPay`, `Visa`, or `Unknown`.
   */
  brand: string
  /**
   * Two-letter ISO code representing the country of the card. You could use this attribute to get a sense of the international breakdown of cards you've collected.
   */
  country?: (string | null)
  /**
   * Three-letter [ISO code for currency](https://stripe.com/docs/payouts). Only applicable on accounts (not customers or recipients). The card can be used as a transfer destination for funds in this currency.
   */
  currency?: (string | null)
  /**
   * The customer that this card belongs to. This attribute will not be in the card object if the card belongs to an account or recipient instead.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * If a CVC was provided, results of the check: `pass`, `fail`, `unavailable`, or `unchecked`. A result of unchecked indicates that CVC was provided but hasn't been checked yet. Checks are typically performed when attaching a card to a Customer object, or when creating a charge. For more details, see [Check if a card is valid without a charge](https://support.stripe.com/questions/check-if-a-card-is-valid-without-a-charge).
   */
  cvc_check?: (string | null)
  /**
   * Whether this card is the default external account for its currency.
   */
  default_for_currency?: (boolean | null)
  /**
   * (For tokenized numbers only.) The last four digits of the device account number.
   */
  dynamic_last4?: (string | null)
  /**
   * Two-digit number representing the card's expiration month.
   */
  exp_month: number
  /**
   * Four-digit number representing the card's expiration year.
   */
  exp_year: number
  /**
   * Uniquely identifies this particular card number. You can use this attribute to check whether two customers who’ve signed up with you are using the same card number, for example. For payment methods that tokenize card information (Apple Pay, Google Pay), the tokenized number might be provided instead of the underlying card number.
   * 
   * *Starting May 1, 2021, card fingerprint in India for Connect will change to allow two fingerprints for the same card --- one for India and one for the rest of the world.*
   */
  fingerprint?: (string | null)
  /**
   * Card funding type. Can be `credit`, `debit`, `prepaid`, or `unknown`.
   */
  funding: string
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The last four digits of the card.
   */
  last4: string
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * Cardholder name.
   */
  name?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "card"
  /**
   * For external accounts, possible values are `new` and `errored`. If a transfer fails, the status is set to `errored` and transfers are stopped until account details are updated.
   */
  status?: (string | null)
  /**
   * If the card number is tokenized, this is the method that was used. Can be `android_pay` (includes Google Pay), `apple_pay`, `masterpass`, `visa_checkout`, or null.
   */
  tokenization_method?: (string | null)
}
export interface DeletedCustomer {
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "customer"
}
export interface AccountFutureRequirements {
  /**
   * Fields that are due and can be satisfied by providing the corresponding alternative fields instead.
   */
  alternatives?: (AccountRequirementsAlternative[] | null)
  /**
   * Date on which `future_requirements` merges with the main `requirements` hash and `future_requirements` becomes empty. After the transition, `currently_due` requirements may immediately become `past_due`, but the account may also be given a grace period depending on its enablement state prior to transitioning.
   */
  current_deadline?: (number | null)
  /**
   * Fields that need to be collected to keep the account enabled. If not collected by `future_requirements[current_deadline]`, these fields will transition to the main `requirements` hash.
   */
  currently_due?: (string[] | null)
  /**
   * This is typed as a string for consistency with `requirements.disabled_reason`, but it safe to assume `future_requirements.disabled_reason` is empty because fields in `future_requirements` will never disable the account.
   */
  disabled_reason?: (string | null)
  /**
   * Fields that are `currently_due` and need to be collected again because validation or verification failed.
   */
  errors?: (AccountRequirementsError[] | null)
  /**
   * Fields that need to be collected assuming all volume thresholds are reached. As they become required, they appear in `currently_due` as well.
   */
  eventually_due?: (string[] | null)
  /**
   * Fields that weren't collected by `requirements.current_deadline`. These fields need to be collected to enable the capability on the account. New fields will never appear here; `future_requirements.past_due` will always be a subset of `requirements.past_due`.
   */
  past_due?: (string[] | null)
  /**
   * Fields that may become required depending on the results of verification or review. Will be an empty array unless an asynchronous verification is pending. If verification fails, these fields move to `eventually_due` or `currently_due`.
   */
  pending_verification?: (string[] | null)
}
export interface AccountRequirementsAlternative {
  /**
   * Fields that can be provided to satisfy all fields in `original_fields_due`.
   */
  alternative_fields_due: string[]
  /**
   * Fields that are due and can be satisfied by providing all fields in `alternative_fields_due`.
   */
  original_fields_due: string[]
}
export interface AccountRequirementsError {
  /**
   * The code for the type of error.
   */
  code: ("invalid_address_city_state_postal_code" | "invalid_dob_age_under_18" | "invalid_representative_country" | "invalid_street_address" | "invalid_tos_acceptance" | "invalid_value_other" | "verification_document_address_mismatch" | "verification_document_address_missing" | "verification_document_corrupt" | "verification_document_country_not_supported" | "verification_document_dob_mismatch" | "verification_document_duplicate_type" | "verification_document_expired" | "verification_document_failed_copy" | "verification_document_failed_greyscale" | "verification_document_failed_other" | "verification_document_failed_test_mode" | "verification_document_fraudulent" | "verification_document_id_number_mismatch" | "verification_document_id_number_missing" | "verification_document_incomplete" | "verification_document_invalid" | "verification_document_issue_or_expiry_date_missing" | "verification_document_manipulated" | "verification_document_missing_back" | "verification_document_missing_front" | "verification_document_name_mismatch" | "verification_document_name_missing" | "verification_document_nationality_mismatch" | "verification_document_not_readable" | "verification_document_not_signed" | "verification_document_not_uploaded" | "verification_document_photo_mismatch" | "verification_document_too_large" | "verification_document_type_not_supported" | "verification_failed_address_match" | "verification_failed_business_iec_number" | "verification_failed_document_match" | "verification_failed_id_number_match" | "verification_failed_keyed_identity" | "verification_failed_keyed_match" | "verification_failed_name_match" | "verification_failed_other" | "verification_failed_residential_address" | "verification_failed_tax_id_match" | "verification_failed_tax_id_not_issued" | "verification_missing_executives" | "verification_missing_owners" | "verification_requires_additional_memorandum_of_associations")
  /**
   * An informative message that indicates the error type and provides additional details about the error.
   */
  reason: string
  /**
   * The specific user onboarding requirement field (in the requirements hash) that needs to be resolved.
   */
  requirement: string
}
/**
 * This is an object representing a person associated with a Stripe account.
 * 
 * A platform cannot access a Standard or Express account's persons after the account starts onboarding, such as after generating an account link for the account.
 * See the [Standard onboarding](https://stripe.com/docs/connect/standard-accounts) or [Express onboarding documentation](https://stripe.com/docs/connect/express-accounts) for information about platform pre-filling and account onboarding steps.
 * 
 * Related guide: [Handling Identity Verification with the API](https://stripe.com/docs/connect/identity-verification-api#person-information).
 */
export interface Person {
  /**
   * The account the person is associated with.
   */
  account: string
  address?: Address
  address_kana?: (LegalEntityJapanAddress | null)
  address_kanji?: (LegalEntityJapanAddress | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  dob?: LegalEntityDOB
  /**
   * The person's email address.
   */
  email?: (string | null)
  /**
   * The person's first name.
   */
  first_name?: (string | null)
  /**
   * The Kana variation of the person's first name (Japan only).
   */
  first_name_kana?: (string | null)
  /**
   * The Kanji variation of the person's first name (Japan only).
   */
  first_name_kanji?: (string | null)
  /**
   * A list of alternate names or aliases that the person is known by.
   */
  full_name_aliases?: string[]
  future_requirements?: (PersonFutureRequirements | null)
  /**
   * The person's gender (International regulations require either "male" or "female").
   */
  gender?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Whether the person's `id_number` was provided.
   */
  id_number_provided?: boolean
  /**
   * Whether the person's `id_number_secondary` was provided.
   */
  id_number_secondary_provided?: boolean
  /**
   * The person's last name.
   */
  last_name?: (string | null)
  /**
   * The Kana variation of the person's last name (Japan only).
   */
  last_name_kana?: (string | null)
  /**
   * The Kanji variation of the person's last name (Japan only).
   */
  last_name_kanji?: (string | null)
  /**
   * The person's maiden name.
   */
  maiden_name?: (string | null)
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: {
    [k: string]: string
  }
  /**
   * The country where the person is a national.
   */
  nationality?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "person"
  /**
   * The person's phone number.
   */
  phone?: (string | null)
  /**
   * Indicates if the person or any of their representatives, family members, or other closely related persons, declares that they hold or have held an important public job or function, in any jurisdiction.
   */
  political_exposure?: ("existing" | "none")
  registered_address?: Address
  relationship?: PersonRelationship
  requirements?: (PersonRequirements | null)
  /**
   * Whether the last four digits of the person's Social Security number have been provided (U.S. only).
   */
  ssn_last_4_provided?: boolean
  verification?: LegalEntityPersonVerification
}
export interface LegalEntityDOB {
  /**
   * The day of birth, between 1 and 31.
   */
  day?: (number | null)
  /**
   * The month of birth, between 1 and 12.
   */
  month?: (number | null)
  /**
   * The four-digit year of birth.
   */
  year?: (number | null)
}
export interface PersonFutureRequirements {
  /**
   * Fields that are due and can be satisfied by providing the corresponding alternative fields instead.
   */
  alternatives?: (AccountRequirementsAlternative[] | null)
  /**
   * Fields that need to be collected to keep the person's account enabled. If not collected by the account's `future_requirements[current_deadline]`, these fields will transition to the main `requirements` hash, and may immediately become `past_due`, but the account may also be given a grace period depending on the account's enablement state prior to transition.
   */
  currently_due: string[]
  /**
   * Fields that are `currently_due` and need to be collected again because validation or verification failed.
   */
  errors: AccountRequirementsError[]
  /**
   * Fields that need to be collected assuming all volume thresholds are reached. As they become required, they appear in `currently_due` as well, and the account's `future_requirements[current_deadline]` becomes set.
   */
  eventually_due: string[]
  /**
   * Fields that weren't collected by the account's `requirements.current_deadline`. These fields need to be collected to enable the person's account. New fields will never appear here; `future_requirements.past_due` will always be a subset of `requirements.past_due`.
   */
  past_due: string[]
  /**
   * Fields that may become required depending on the results of verification or review. Will be an empty array unless an asynchronous verification is pending. If verification fails, these fields move to `eventually_due` or `currently_due`.
   */
  pending_verification: string[]
}
export interface PersonRelationship {
  /**
   * Whether the person is a director of the account's legal entity. Directors are typically members of the governing board of the company, or responsible for ensuring the company meets its regulatory obligations.
   */
  director?: (boolean | null)
  /**
   * Whether the person has significant responsibility to control, manage, or direct the organization.
   */
  executive?: (boolean | null)
  /**
   * Whether the person is an owner of the account’s legal entity.
   */
  owner?: (boolean | null)
  /**
   * The percent owned by the person of the account's legal entity.
   */
  percent_ownership?: (number | null)
  /**
   * Whether the person is authorized as the primary representative of the account. This is the person nominated by the business to provide information about themselves, and general information about the account. There can only be one representative at any given time. At the time the account is created, this person should be set to the person responsible for opening the account.
   */
  representative?: (boolean | null)
  /**
   * The person's title (e.g., CEO, Support Engineer).
   */
  title?: (string | null)
}
export interface PersonRequirements {
  /**
   * Fields that are due and can be satisfied by providing the corresponding alternative fields instead.
   */
  alternatives?: (AccountRequirementsAlternative[] | null)
  /**
   * Fields that need to be collected to keep the person's account enabled. If not collected by the account's `current_deadline`, these fields appear in `past_due` as well, and the account is disabled.
   */
  currently_due: string[]
  /**
   * Fields that are `currently_due` and need to be collected again because validation or verification failed.
   */
  errors: AccountRequirementsError[]
  /**
   * Fields that need to be collected assuming all volume thresholds are reached. As they become required, they appear in `currently_due` as well, and the account's `current_deadline` becomes set.
   */
  eventually_due: string[]
  /**
   * Fields that weren't collected by the account's `current_deadline`. These fields need to be collected to enable the person's account.
   */
  past_due: string[]
  /**
   * Fields that may become required depending on the results of verification or review. Will be an empty array unless an asynchronous verification is pending. If verification fails, these fields move to `eventually_due`, `currently_due`, or `past_due`.
   */
  pending_verification: string[]
}
export interface LegalEntityPersonVerification {
  /**
   * A document showing address, either a passport, local ID card, or utility bill from a well-known utility company.
   */
  additional_document?: (LegalEntityPersonVerificationDocument | null)
  /**
   * A user-displayable string describing the verification state for the person. For example, this may say "Provided identity information could not be verified".
   */
  details?: (string | null)
  /**
   * One of `document_address_mismatch`, `document_dob_mismatch`, `document_duplicate_type`, `document_id_number_mismatch`, `document_name_mismatch`, `document_nationality_mismatch`, `failed_keyed_identity`, or `failed_other`. A machine-readable code specifying the verification state for the person.
   */
  details_code?: (string | null)
  document?: LegalEntityPersonVerificationDocument
  /**
   * The state of verification for the person. Possible values are `unverified`, `pending`, or `verified`.
   */
  status: string
}
export interface LegalEntityPersonVerificationDocument {
  /**
   * The back of an ID returned by a [file upload](https://stripe.com/docs/api#create_file) with a `purpose` value of `identity_document`.
   */
  back?: (string | File | null)
  /**
   * A user-displayable string describing the verification state of this document. For example, if a document is uploaded and the picture is too fuzzy, this may say "Identity document is too unclear to read".
   */
  details?: (string | null)
  /**
   * One of `document_corrupt`, `document_country_not_supported`, `document_expired`, `document_failed_copy`, `document_failed_other`, `document_failed_test_mode`, `document_fraudulent`, `document_failed_greyscale`, `document_incomplete`, `document_invalid`, `document_manipulated`, `document_missing_back`, `document_missing_front`, `document_not_readable`, `document_not_uploaded`, `document_photo_mismatch`, `document_too_large`, or `document_type_not_supported`. A machine-readable code specifying the verification state for this document.
   */
  details_code?: (string | null)
  /**
   * The front of an ID returned by a [file upload](https://stripe.com/docs/api#create_file) with a `purpose` value of `identity_document`.
   */
  front?: (string | File | null)
}
export interface AccountRequirements {
  /**
   * Fields that are due and can be satisfied by providing the corresponding alternative fields instead.
   */
  alternatives?: (AccountRequirementsAlternative[] | null)
  /**
   * Date by which the fields in `currently_due` must be collected to keep the account enabled. These fields may disable the account sooner if the next threshold is reached before they are collected.
   */
  current_deadline?: (number | null)
  /**
   * Fields that need to be collected to keep the account enabled. If not collected by `current_deadline`, these fields appear in `past_due` as well, and the account is disabled.
   */
  currently_due?: (string[] | null)
  /**
   * If the account is disabled, this string describes why. Can be `requirements.past_due`, `requirements.pending_verification`, `listed`, `platform_paused`, `rejected.fraud`, `rejected.listed`, `rejected.terms_of_service`, `rejected.other`, `under_review`, or `other`.
   */
  disabled_reason?: (string | null)
  /**
   * Fields that are `currently_due` and need to be collected again because validation or verification failed.
   */
  errors?: (AccountRequirementsError[] | null)
  /**
   * Fields that need to be collected assuming all volume thresholds are reached. As they become required, they appear in `currently_due` as well, and `current_deadline` becomes set.
   */
  eventually_due?: (string[] | null)
  /**
   * Fields that weren't collected by `current_deadline`. These fields need to be collected to enable the account.
   */
  past_due?: (string[] | null)
  /**
   * Fields that may become required depending on the results of verification or review. Will be an empty array unless an asynchronous verification is pending. If verification fails, these fields move to `eventually_due`, `currently_due`, or `past_due`.
   */
  pending_verification?: (string[] | null)
}
export interface AccountSettings {
  bacs_debit_payments?: AccountBacsDebitPaymentsSettings
  branding: AccountBrandingSettings
  card_issuing?: AccountCardIssuingSettings
  card_payments: AccountCardPaymentsSettings
  dashboard: AccountDashboardSettings
  payments: AccountPaymentsSettings
  payouts?: AccountPayoutSettings
  sepa_debit_payments?: AccountSepaDebitPaymentsSettings
  treasury?: AccountTreasurySettings
}
export interface AccountBacsDebitPaymentsSettings {
  /**
   * The Bacs Direct Debit Display Name for this account. For payments made with Bacs Direct Debit, this will appear on the mandate, and as the statement descriptor.
   */
  display_name?: string
}
export interface AccountBrandingSettings {
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) An icon for the account. Must be square and at least 128px x 128px.
   */
  icon?: (string | File | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) A logo for the account that will be used in Checkout instead of the icon and without the account's name next to it if provided. Must be at least 128px x 128px.
   */
  logo?: (string | File | null)
  /**
   * A CSS hex color value representing the primary branding color for this account
   */
  primary_color?: (string | null)
  /**
   * A CSS hex color value representing the secondary branding color for this account
   */
  secondary_color?: (string | null)
}
export interface AccountCardIssuingSettings {
  tos_acceptance?: CardIssuingAccountTermsOfService
}
export interface CardIssuingAccountTermsOfService {
  /**
   * The Unix timestamp marking when the account representative accepted the service agreement.
   */
  date?: (number | null)
  /**
   * The IP address from which the account representative accepted the service agreement.
   */
  ip?: (string | null)
  /**
   * The user agent of the browser from which the account representative accepted the service agreement.
   */
  user_agent?: string
}
export interface AccountCardPaymentsSettings {
  decline_on?: AccountDeclineChargeOn
  /**
   * The default text that appears on credit card statements when a charge is made. This field prefixes any dynamic `statement_descriptor` specified on the charge. `statement_descriptor_prefix` is useful for maximizing descriptor space for the dynamic portion.
   */
  statement_descriptor_prefix?: (string | null)
  /**
   * The Kana variation of the default text that appears on credit card statements when a charge is made (Japan only). This field prefixes any dynamic `statement_descriptor_suffix_kana` specified on the charge. `statement_descriptor_prefix_kana` is useful for maximizing descriptor space for the dynamic portion.
   */
  statement_descriptor_prefix_kana?: (string | null)
  /**
   * The Kanji variation of the default text that appears on credit card statements when a charge is made (Japan only). This field prefixes any dynamic `statement_descriptor_suffix_kanji` specified on the charge. `statement_descriptor_prefix_kanji` is useful for maximizing descriptor space for the dynamic portion.
   */
  statement_descriptor_prefix_kanji?: (string | null)
}
export interface AccountDeclineChargeOn {
  /**
   * Whether Stripe automatically declines charges with an incorrect ZIP or postal code. This setting only applies when a ZIP or postal code is provided and they fail bank verification.
   */
  avs_failure: boolean
  /**
   * Whether Stripe automatically declines charges with an incorrect CVC. This setting only applies when a CVC is provided and it fails bank verification.
   */
  cvc_failure: boolean
}
export interface AccountDashboardSettings {
  /**
   * The display name for this account. This is used on the Stripe Dashboard to differentiate between accounts.
   */
  display_name?: (string | null)
  /**
   * The timezone used in the Stripe Dashboard for this account. A list of possible time zone values is maintained at the [IANA Time Zone Database](http://www.iana.org/time-zones).
   */
  timezone?: (string | null)
}
export interface AccountPaymentsSettings {
  /**
   * The default text that appears on credit card statements when a charge is made. This field prefixes any dynamic `statement_descriptor` specified on the charge.
   */
  statement_descriptor?: (string | null)
  /**
   * The Kana variation of the default text that appears on credit card statements when a charge is made (Japan only)
   */
  statement_descriptor_kana?: (string | null)
  /**
   * The Kanji variation of the default text that appears on credit card statements when a charge is made (Japan only)
   */
  statement_descriptor_kanji?: (string | null)
  /**
   * The Kana variation of the default text that appears on credit card statements when a charge is made (Japan only). This field prefixes any dynamic `statement_descriptor_suffix_kana` specified on the charge. `statement_descriptor_prefix_kana` is useful for maximizing descriptor space for the dynamic portion.
   */
  statement_descriptor_prefix_kana?: (string | null)
  /**
   * The Kanji variation of the default text that appears on credit card statements when a charge is made (Japan only). This field prefixes any dynamic `statement_descriptor_suffix_kanji` specified on the charge. `statement_descriptor_prefix_kanji` is useful for maximizing descriptor space for the dynamic portion.
   */
  statement_descriptor_prefix_kanji?: (string | null)
}
export interface AccountPayoutSettings {
  /**
   * A Boolean indicating if Stripe should try to reclaim negative balances from an attached bank account. See our [Understanding Connect Account Balances](https://stripe.com/docs/connect/account-balances) documentation for details. Default value is `false` for Custom accounts, otherwise `true`.
   */
  debit_negative_balances: boolean
  schedule: TransferSchedule
  /**
   * The text that appears on the bank account statement for payouts. If not set, this defaults to the platform's bank descriptor as set in the Dashboard.
   */
  statement_descriptor?: (string | null)
}
export interface TransferSchedule {
  /**
   * The number of days charges for the account will be held before being paid out.
   */
  delay_days: number
  /**
   * How frequently funds will be paid out. One of `manual` (payouts only created via API call), `daily`, `weekly`, or `monthly`.
   */
  interval: string
  /**
   * The day of the month funds will be paid out. Only shown if `interval` is monthly. Payouts scheduled between the 29th and 31st of the month are sent on the last day of shorter months.
   */
  monthly_anchor?: number
  /**
   * The day of the week funds will be paid out, of the style 'monday', 'tuesday', etc. Only shown if `interval` is weekly.
   */
  weekly_anchor?: string
}
export interface AccountSepaDebitPaymentsSettings {
  /**
   * SEPA creditor identifier that identifies the company making the payment.
   */
  creditor_id?: string
}
export interface AccountTreasurySettings {
  tos_acceptance?: AccountTermsOfService
}
export interface AccountTermsOfService {
  /**
   * The Unix timestamp marking when the account representative accepted the service agreement.
   */
  date?: (number | null)
  /**
   * The IP address from which the account representative accepted the service agreement.
   */
  ip?: (string | null)
  /**
   * The user agent of the browser from which the account representative accepted the service agreement.
   */
  user_agent?: string
}
export interface AccountTOSAcceptance {
  /**
   * The Unix timestamp marking when the account representative accepted their service agreement
   */
  date?: (number | null)
  /**
   * The IP address from which the account representative accepted their service agreement
   */
  ip?: (string | null)
  /**
   * The user's service agreement type
   */
  service_agreement?: string
  /**
   * The user agent of the browser from which the account representative accepted their service agreement
   */
  user_agent?: (string | null)
}
/**
 * `Source` objects allow you to accept a variety of payment methods. They
 * represent a customer's payment instrument, and can be used with the Stripe API
 * just like a `Card` object: once chargeable, they can be charged, or can be
 * attached to customers.
 * 
 * Stripe doesn't recommend using the deprecated [Sources API](https://stripe.com/docs/api/sources).
 * We recommend that you adopt the [PaymentMethods API](https://stripe.com/docs/api/payment_methods).
 * This newer API provides access to our latest features and payment method types.
 * 
 * Related guides: [Sources API](https://stripe.com/docs/sources) and [Sources & Customers](https://stripe.com/docs/sources/customers).
 */
export interface Source {
  ach_credit_transfer?: SourceTypeAchCreditTransfer
  ach_debit?: SourceTypeAchDebit
  acss_debit?: SourceTypeAcssDebit
  alipay?: SourceTypeAlipay
  /**
   * A positive integer in the smallest currency unit (that is, 100 cents for $1.00, or 1 for ¥1, Japanese Yen being a zero-decimal currency) representing the total amount associated with the source. This is the amount for which the source will be chargeable once ready. Required for `single_use` sources.
   */
  amount?: (number | null)
  au_becs_debit?: SourceTypeAuBecsDebit
  bancontact?: SourceTypeBancontact
  card?: SourceTypeCard
  card_present?: SourceTypeCardPresent
  /**
   * The client secret of the source. Used for client-side retrieval using a publishable key.
   */
  client_secret: string
  code_verification?: SourceCodeVerificationFlow
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO code for the currency](https://stripe.com/docs/currencies) associated with the source. This is the currency for which the source will be chargeable once ready. Required for `single_use` sources.
   */
  currency?: (string | null)
  /**
   * The ID of the customer to which this source is attached. This will not be present when the source has not been attached to a customer.
   */
  customer?: string
  eps?: SourceTypeEps
  /**
   * The authentication `flow` of the source. `flow` is one of `redirect`, `receiver`, `code_verification`, `none`.
   */
  flow: string
  giropay?: SourceTypeGiropay
  /**
   * Unique identifier for the object.
   */
  id: string
  ideal?: SourceTypeIdeal
  klarna?: SourceTypeKlarna
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  multibanco?: SourceTypeMultibanco
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "source"
  /**
   * Information about the owner of the payment instrument that may be used or required by particular source types.
   */
  owner?: (SourceOwner | null)
  p24?: SourceTypeP24
  receiver?: SourceReceiverFlow
  redirect?: SourceRedirectFlow
  sepa_debit?: SourceTypeSepaDebit
  sofort?: SourceTypeSofort
  source_order?: SourceOrder
  /**
   * Extra information about a source. This will appear on your customer's statement every time you charge the source.
   */
  statement_descriptor?: (string | null)
  /**
   * The status of the source, one of `canceled`, `chargeable`, `consumed`, `failed`, or `pending`. Only `chargeable` sources can be used to create a charge.
   */
  status: string
  three_d_secure?: SourceTypeThreeDSecure
  /**
   * The `type` of the source. The `type` is a payment method, one of `ach_credit_transfer`, `ach_debit`, `alipay`, `bancontact`, `card`, `card_present`, `eps`, `giropay`, `ideal`, `multibanco`, `klarna`, `p24`, `sepa_debit`, `sofort`, `three_d_secure`, or `wechat`. An additional hash is included on the source with a name matching this value. It contains additional information specific to the [payment method](https://stripe.com/docs/sources) used.
   */
  type: ("ach_credit_transfer" | "ach_debit" | "acss_debit" | "alipay" | "au_becs_debit" | "bancontact" | "card" | "card_present" | "eps" | "giropay" | "ideal" | "klarna" | "multibanco" | "p24" | "sepa_debit" | "sofort" | "three_d_secure" | "wechat")
  /**
   * Either `reusable` or `single_use`. Whether this source should be reusable or not. Some source types may or may not be reusable by construction, while others may leave the option at creation. If an incompatible value is passed, an error will be returned.
   */
  usage?: (string | null)
  wechat?: SourceTypeWechat
}
export interface SourceTypeAchCreditTransfer {
  account_number?: (string | null)
  bank_name?: (string | null)
  fingerprint?: (string | null)
  refund_account_holder_name?: (string | null)
  refund_account_holder_type?: (string | null)
  refund_routing_number?: (string | null)
  routing_number?: (string | null)
  swift_code?: (string | null)
}
export interface SourceTypeAchDebit {
  bank_name?: (string | null)
  country?: (string | null)
  fingerprint?: (string | null)
  last4?: (string | null)
  routing_number?: (string | null)
  type?: (string | null)
}
export interface SourceTypeAcssDebit {
  bank_address_city?: (string | null)
  bank_address_line_1?: (string | null)
  bank_address_line_2?: (string | null)
  bank_address_postal_code?: (string | null)
  bank_name?: (string | null)
  category?: (string | null)
  country?: (string | null)
  fingerprint?: (string | null)
  last4?: (string | null)
  routing_number?: (string | null)
}
export interface SourceTypeAlipay {
  data_string?: (string | null)
  native_url?: (string | null)
  statement_descriptor?: (string | null)
}
export interface SourceTypeAuBecsDebit {
  bsb_number?: (string | null)
  fingerprint?: (string | null)
  last4?: (string | null)
}
export interface SourceTypeBancontact {
  bank_code?: (string | null)
  bank_name?: (string | null)
  bic?: (string | null)
  iban_last4?: (string | null)
  preferred_language?: (string | null)
  statement_descriptor?: (string | null)
}
export interface SourceTypeCard {
  address_line1_check?: (string | null)
  address_zip_check?: (string | null)
  brand?: (string | null)
  country?: (string | null)
  cvc_check?: (string | null)
  dynamic_last4?: (string | null)
  exp_month?: (number | null)
  exp_year?: (number | null)
  fingerprint?: string
  funding?: (string | null)
  last4?: (string | null)
  name?: (string | null)
  three_d_secure?: string
  tokenization_method?: (string | null)
}
export interface SourceTypeCardPresent {
  application_cryptogram?: string
  application_preferred_name?: string
  authorization_code?: (string | null)
  authorization_response_code?: string
  brand?: (string | null)
  country?: (string | null)
  cvm_type?: string
  data_type?: (string | null)
  dedicated_file_name?: string
  emv_auth_data?: string
  evidence_customer_signature?: (string | null)
  evidence_transaction_certificate?: (string | null)
  exp_month?: (number | null)
  exp_year?: (number | null)
  fingerprint?: string
  funding?: (string | null)
  last4?: (string | null)
  pos_device_id?: (string | null)
  pos_entry_mode?: string
  read_method?: (string | null)
  reader?: (string | null)
  terminal_verification_results?: string
  transaction_status_information?: string
}
export interface SourceCodeVerificationFlow {
  /**
   * The number of attempts remaining to authenticate the source object with a verification code.
   */
  attempts_remaining: number
  /**
   * The status of the code verification, either `pending` (awaiting verification, `attempts_remaining` should be greater than 0), `succeeded` (successful verification) or `failed` (failed verification, cannot be verified anymore as `attempts_remaining` should be 0).
   */
  status: string
}
export interface SourceTypeEps {
  reference?: (string | null)
  statement_descriptor?: (string | null)
}
export interface SourceTypeGiropay {
  bank_code?: (string | null)
  bank_name?: (string | null)
  bic?: (string | null)
  statement_descriptor?: (string | null)
}
export interface SourceTypeIdeal {
  bank?: (string | null)
  bic?: (string | null)
  iban_last4?: (string | null)
  statement_descriptor?: (string | null)
}
export interface SourceTypeKlarna {
  background_image_url?: string
  client_token?: (string | null)
  first_name?: string
  last_name?: string
  locale?: string
  logo_url?: string
  page_title?: string
  pay_later_asset_urls_descriptive?: string
  pay_later_asset_urls_standard?: string
  pay_later_name?: string
  pay_later_redirect_url?: string
  pay_now_asset_urls_descriptive?: string
  pay_now_asset_urls_standard?: string
  pay_now_name?: string
  pay_now_redirect_url?: string
  pay_over_time_asset_urls_descriptive?: string
  pay_over_time_asset_urls_standard?: string
  pay_over_time_name?: string
  pay_over_time_redirect_url?: string
  payment_method_categories?: string
  purchase_country?: string
  purchase_type?: string
  redirect_url?: string
  shipping_delay?: number
  shipping_first_name?: string
  shipping_last_name?: string
}
export interface SourceTypeMultibanco {
  entity?: (string | null)
  reference?: (string | null)
  refund_account_holder_address_city?: (string | null)
  refund_account_holder_address_country?: (string | null)
  refund_account_holder_address_line1?: (string | null)
  refund_account_holder_address_line2?: (string | null)
  refund_account_holder_address_postal_code?: (string | null)
  refund_account_holder_address_state?: (string | null)
  refund_account_holder_name?: (string | null)
  refund_iban?: (string | null)
}
export interface SourceOwner {
  /**
   * Owner's address.
   */
  address?: (Address | null)
  /**
   * Owner's email address.
   */
  email?: (string | null)
  /**
   * Owner's full name.
   */
  name?: (string | null)
  /**
   * Owner's phone number (including extension).
   */
  phone?: (string | null)
  /**
   * Verified owner's address. Verified values are verified or provided by the payment method directly (and if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_address?: (Address | null)
  /**
   * Verified owner's email address. Verified values are verified or provided by the payment method directly (and if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_email?: (string | null)
  /**
   * Verified owner's full name. Verified values are verified or provided by the payment method directly (and if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_name?: (string | null)
  /**
   * Verified owner's phone number (including extension). Verified values are verified or provided by the payment method directly (and if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_phone?: (string | null)
}
export interface SourceTypeP24 {
  reference?: (string | null)
}
export interface SourceReceiverFlow {
  /**
   * The address of the receiver source. This is the value that should be communicated to the customer to send their funds to.
   */
  address?: (string | null)
  /**
   * The total amount that was moved to your balance. This is almost always equal to the amount charged. In rare cases when customers deposit excess funds and we are unable to refund those, those funds get moved to your balance and show up in amount_charged as well. The amount charged is expressed in the source's currency.
   */
  amount_charged: number
  /**
   * The total amount received by the receiver source. `amount_received = amount_returned + amount_charged` should be true for consumed sources unless customers deposit excess funds. The amount received is expressed in the source's currency.
   */
  amount_received: number
  /**
   * The total amount that was returned to the customer. The amount returned is expressed in the source's currency.
   */
  amount_returned: number
  /**
   * Type of refund attribute method, one of `email`, `manual`, or `none`.
   */
  refund_attributes_method: string
  /**
   * Type of refund attribute status, one of `missing`, `requested`, or `available`.
   */
  refund_attributes_status: string
}
export interface SourceRedirectFlow {
  /**
   * The failure reason for the redirect, either `user_abort` (the customer aborted or dropped out of the redirect flow), `declined` (the authentication failed or the transaction was declined), or `processing_error` (the redirect failed due to a technical error). Present only if the redirect status is `failed`.
   */
  failure_reason?: (string | null)
  /**
   * The URL you provide to redirect the customer to after they authenticated their payment.
   */
  return_url: string
  /**
   * The status of the redirect, either `pending` (ready to be used by your customer to authenticate the transaction), `succeeded` (succesful authentication, cannot be reused) or `not_required` (redirect should not be used) or `failed` (failed authentication, cannot be reused).
   */
  status: string
  /**
   * The URL provided to you to redirect a customer to as part of a `redirect` authentication flow.
   */
  url: string
}
export interface SourceTypeSepaDebit {
  bank_code?: (string | null)
  branch_code?: (string | null)
  country?: (string | null)
  fingerprint?: (string | null)
  last4?: (string | null)
  mandate_reference?: (string | null)
  mandate_url?: (string | null)
}
export interface SourceTypeSofort {
  bank_code?: (string | null)
  bank_name?: (string | null)
  bic?: (string | null)
  country?: (string | null)
  iban_last4?: (string | null)
  preferred_language?: (string | null)
  statement_descriptor?: (string | null)
}
export interface SourceOrder {
  /**
   * A positive integer in the smallest currency unit (that is, 100 cents for $1.00, or 1 for ¥1, Japanese Yen being a zero-decimal currency) representing the total amount for the order.
   */
  amount: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * The email address of the customer placing the order.
   */
  email?: string
  /**
   * List of items constituting the order.
   */
  items?: (SourceOrderItem[] | null)
  shipping?: Shipping
  minItems?: 0
}
export interface SourceOrderItem {
  /**
   * The amount (price) for this order item.
   */
  amount?: (number | null)
  /**
   * This currency of this order item. Required when `amount` is present.
   */
  currency?: (string | null)
  /**
   * Human-readable description for this order item.
   */
  description?: (string | null)
  /**
   * The ID of the associated object for this line item. Expandable if not null (e.g., expandable to a SKU).
   */
  parent?: (string | null)
  /**
   * The quantity of this order item. When type is `sku`, this is the number of instances of the SKU to be ordered.
   */
  quantity?: number
  /**
   * The type of this order item. Must be `sku`, `tax`, or `shipping`.
   */
  type?: (string | null)
}
export interface Shipping {
  address?: Address
  /**
   * The delivery service that shipped a physical product, such as Fedex, UPS, USPS, etc.
   */
  carrier?: (string | null)
  /**
   * Recipient name.
   */
  name?: string
  /**
   * Recipient phone (including extension).
   */
  phone?: (string | null)
  /**
   * The tracking number for a physical product, obtained from the delivery service. If multiple tracking numbers were generated for this purchase, please separate them with commas.
   */
  tracking_number?: (string | null)
}
export interface SourceTypeThreeDSecure {
  address_line1_check?: (string | null)
  address_zip_check?: (string | null)
  authenticated?: (boolean | null)
  brand?: (string | null)
  card?: (string | null)
  country?: (string | null)
  customer?: (string | null)
  cvc_check?: (string | null)
  dynamic_last4?: (string | null)
  exp_month?: (number | null)
  exp_year?: (number | null)
  fingerprint?: string
  funding?: (string | null)
  last4?: (string | null)
  name?: (string | null)
  three_d_secure?: string
  tokenization_method?: (string | null)
}
export interface SourceTypeWechat {
  prepay_id?: string
  qr_code_url?: (string | null)
  statement_descriptor?: string
}
/**
 * A discount represents the actual application of a [coupon](https://stripe.com/docs/api#coupons) or [promotion code](https://stripe.com/docs/api#promotion_codes).
 * It contains information about when the discount began, when it will end, and what it is applied to.
 * 
 * Related guide: [Applying Discounts to Subscriptions](https://stripe.com/docs/billing/subscriptions/discounts).
 */
export interface Discount {
  /**
   * The Checkout session that this coupon is applied to, if it is applied to a particular session in payment mode. Will not be present for subscription mode.
   */
  checkout_session?: (string | null)
  coupon: Coupon
  /**
   * The ID of the customer associated with this discount.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * If the coupon has a duration of `repeating`, the date that this discount will end. If the coupon has a duration of `once` or `forever`, this attribute will be null.
   */
  end?: (number | null)
  /**
   * The ID of the discount object. Discounts cannot be fetched by ID. Use `expand[]=discounts` in API calls to expand discount IDs in an array.
   */
  id: string
  /**
   * The invoice that the discount's coupon was applied to, if it was applied directly to a particular invoice.
   */
  invoice?: (string | null)
  /**
   * The invoice item `id` (or invoice line item `id` for invoice line items of type='subscription') that the discount's coupon was applied to, if it was applied directly to a particular invoice item or invoice line item.
   */
  invoice_item?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "discount"
  /**
   * The promotion code applied to create this discount.
   */
  promotion_code?: (string | PromotionCode | null)
  /**
   * Date that the coupon was applied.
   */
  start: number
  /**
   * The subscription that this coupon is applied to, if it is applied to a particular subscription.
   */
  subscription?: (string | null)
}
/**
 * A coupon contains information about a percent-off or amount-off discount you
 * might want to apply to a customer. Coupons may be applied to [subscriptions](https://stripe.com/docs/api#subscriptions), [invoices](https://stripe.com/docs/api#invoices),
 * [checkout sessions](https://stripe.com/docs/api/checkout/sessions), [quotes](https://stripe.com/docs/api#quotes), and more. Coupons do not work with conventional one-off [charges](https://stripe.com/docs/api#create_charge) or [payment intents](https://stripe.com/docs/api/payment_intents).
 */
export interface Coupon {
  /**
   * Amount (in the `currency` specified) that will be taken off the subtotal of any invoices for this customer.
   */
  amount_off?: (number | null)
  applies_to?: CouponAppliesTo
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * If `amount_off` has been set, the three-letter [ISO code for the currency](https://stripe.com/docs/currencies) of the amount to take off.
   */
  currency?: (string | null)
  /**
   * Coupons defined in each available currency option. Each key must be a three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html) and a [supported currency](https://stripe.com/docs/currencies).
   */
  currency_options?: {
    [k: string]: CouponCurrencyOption
  }
  /**
   * One of `forever`, `once`, and `repeating`. Describes how long a customer who applies this coupon will get the discount.
   */
  duration: ("forever" | "once" | "repeating")
  /**
   * If `duration` is `repeating`, the number of months the coupon applies. Null if coupon `duration` is `forever` or `once`.
   */
  duration_in_months?: (number | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Maximum number of times this coupon can be redeemed, in total, across all customers, before it is no longer valid.
   */
  max_redemptions?: (number | null)
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * Name of the coupon displayed to customers on for instance invoices or receipts.
   */
  name?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "coupon"
  /**
   * Percent that will be taken off the subtotal of any invoices for this customer for the duration of the coupon. For example, a coupon with percent_off of 50 will make a %s100 invoice %s50 instead.
   */
  percent_off?: (number | null)
  /**
   * Date after which the coupon can no longer be redeemed.
   */
  redeem_by?: (number | null)
  /**
   * Number of times this coupon has been applied to a customer.
   */
  times_redeemed: number
  /**
   * Taking account of the above properties, whether this coupon can still be applied to a customer.
   */
  valid: boolean
}
export interface CouponAppliesTo {
  /**
   * A list of product IDs this coupon applies to
   */
  products: string[]
}
export interface CouponCurrencyOption {
  /**
   * Amount (in the `currency` specified) that will be taken off the subtotal of any invoices for this customer.
   */
  amount_off: number
}
/**
 * A Promotion Code represents a customer-redeemable code for a [coupon](https://stripe.com/docs/api#coupons). It can be used to
 * create multiple codes for a single coupon.
 */
export interface PromotionCode {
  /**
   * Whether the promotion code is currently active. A promotion code is only active if the coupon is also valid.
   */
  active: boolean
  /**
   * The customer-facing code. Regardless of case, this code must be unique across all active promotion codes for each customer.
   */
  code: string
  coupon: Coupon
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * The customer that this promotion code can be used by.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * Date at which the promotion code can no longer be redeemed.
   */
  expires_at?: (number | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Maximum number of times this promotion code can be redeemed.
   */
  max_redemptions?: (number | null)
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "promotion_code"
  restrictions: PromotionCodesResourceRestrictions
  /**
   * Number of times this promotion code has been used.
   */
  times_redeemed: number
}
export interface PromotionCodesResourceRestrictions {
  /**
   * Promotion code restrictions defined in each available currency option. Each key must be a three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html) and a [supported currency](https://stripe.com/docs/currencies).
   */
  currency_options?: {
    [k: string]: PromotionCodeCurrencyOption
  }
  /**
   * A Boolean indicating if the Promotion Code should only be redeemed for Customers without any successful payments or invoices
   */
  first_time_transaction: boolean
  /**
   * Minimum amount required to redeem this Promotion Code into a Coupon (e.g., a purchase must be $100 or more to work).
   */
  minimum_amount?: (number | null)
  /**
   * Three-letter [ISO code](https://stripe.com/docs/currencies) for minimum_amount
   */
  minimum_amount_currency?: (string | null)
}
export interface PromotionCodeCurrencyOption {
  /**
   * Minimum amount required to redeem this Promotion Code into a Coupon (e.g., a purchase must be $100 or more to work).
   */
  minimum_amount: number
}
export interface InvoiceSettingCustomerSetting {
  /**
   * Default custom fields to be displayed on invoices for this customer.
   */
  custom_fields?: (InvoiceSettingCustomField[] | null)
  /**
   * ID of a payment method that's attached to the customer, to be used as the customer's default payment method for subscriptions and invoices.
   */
  default_payment_method?: (string | PaymentMethod | null)
  /**
   * Default footer to be displayed on invoices for this customer.
   */
  footer?: (string | null)
  /**
   * Default options for invoice PDF rendering for this customer.
   */
  rendering_options?: (InvoiceSettingRenderingOptions | null)
}
export interface InvoiceSettingCustomField {
  /**
   * The name of the custom field.
   */
  name: string
  /**
   * The value of the custom field.
   */
  value: string
}
/**
 * PaymentMethod objects represent your customer's payment instruments.
 * You can use them with [PaymentIntents](https://stripe.com/docs/payments/payment-intents) to collect payments or save them to
 * Customer objects to store instrument details for future payments.
 * 
 * Related guides: [Payment Methods](https://stripe.com/docs/payments/payment-methods) and [More Payment Scenarios](https://stripe.com/docs/payments/more-payment-scenarios).
 */
export interface PaymentMethod {
  acss_debit?: PaymentMethodAcssDebit
  affirm?: PaymentMethodAffirm
  afterpay_clearpay?: PaymentMethodAfterpayClearpay
  alipay?: PaymentFlowsPrivatePaymentMethodsAlipay
  au_becs_debit?: PaymentMethodAuBecsDebit
  bacs_debit?: PaymentMethodBacsDebit
  bancontact?: PaymentMethodBancontact
  billing_details: BillingDetails
  blik?: PaymentMethodBlik
  boleto?: PaymentMethodBoleto
  card?: PaymentMethodCard
  card_present?: PaymentMethodCardPresent
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * The ID of the Customer to which this PaymentMethod is saved. This will not be set when the PaymentMethod has not been saved to a Customer.
   */
  customer?: (string | Customer | null)
  customer_balance?: PaymentMethodCustomerBalance
  eps?: PaymentMethodEps
  fpx?: PaymentMethodFpx
  giropay?: PaymentMethodGiropay
  grabpay?: PaymentMethodGrabpay
  /**
   * Unique identifier for the object.
   */
  id: string
  ideal?: PaymentMethodIdeal
  interac_present?: PaymentMethodInteracPresent
  klarna?: PaymentMethodKlarna
  konbini?: PaymentMethodKonbini
  link?: PaymentMethodLink
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "payment_method"
  oxxo?: PaymentMethodOxxo
  p24?: PaymentMethodP24
  paynow?: PaymentMethodPaynow
  pix?: PaymentMethodPix
  promptpay?: PaymentMethodPromptpay
  radar_options?: RadarRadarOptions
  sepa_debit?: PaymentMethodSepaDebit
  sofort?: PaymentMethodSofort
  /**
   * The type of the PaymentMethod. An additional hash is included on the PaymentMethod with a name matching this value. It contains additional information specific to the PaymentMethod type.
   */
  type: ("acss_debit" | "affirm" | "afterpay_clearpay" | "alipay" | "au_becs_debit" | "bacs_debit" | "bancontact" | "blik" | "boleto" | "card" | "card_present" | "customer_balance" | "eps" | "fpx" | "giropay" | "grabpay" | "ideal" | "interac_present" | "klarna" | "konbini" | "link" | "oxxo" | "p24" | "paynow" | "pix" | "promptpay" | "sepa_debit" | "sofort" | "us_bank_account" | "wechat_pay")
  us_bank_account?: PaymentMethodUsBankAccount
  wechat_pay?: PaymentMethodWechatPay
}
export interface PaymentMethodAcssDebit {
  /**
   * Name of the bank associated with the bank account.
   */
  bank_name?: (string | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Institution number of the bank account.
   */
  institution_number?: (string | null)
  /**
   * Last four digits of the bank account number.
   */
  last4?: (string | null)
  /**
   * Transit number of the bank account.
   */
  transit_number?: (string | null)
}
export interface PaymentMethodAffirm {

}
export interface PaymentMethodAfterpayClearpay {

}
export interface PaymentFlowsPrivatePaymentMethodsAlipay {

}
export interface PaymentMethodAuBecsDebit {
  /**
   * Six-digit number identifying bank and branch associated with this bank account.
   */
  bsb_number?: (string | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Last four digits of the bank account number.
   */
  last4?: (string | null)
}
export interface PaymentMethodBacsDebit {
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Last four digits of the bank account number.
   */
  last4?: (string | null)
  /**
   * Sort code of the bank account. (e.g., `10-20-30`)
   */
  sort_code?: (string | null)
}
export interface PaymentMethodBancontact {

}
export interface BillingDetails {
  /**
   * Billing address.
   */
  address?: (Address | null)
  /**
   * Email address.
   */
  email?: (string | null)
  /**
   * Full name.
   */
  name?: (string | null)
  /**
   * Billing phone number (including extension).
   */
  phone?: (string | null)
}
export interface PaymentMethodBlik {

}
export interface PaymentMethodBoleto {
  /**
   * Uniquely identifies the customer tax id (CNPJ or CPF)
   */
  tax_id: string
}
export interface PaymentMethodCard {
  /**
   * Card brand. Can be `amex`, `diners`, `discover`, `jcb`, `mastercard`, `unionpay`, `visa`, or `unknown`.
   */
  brand: string
  /**
   * Checks on Card address and CVC if provided.
   */
  checks?: (PaymentMethodCardChecks | null)
  /**
   * Two-letter ISO code representing the country of the card. You could use this attribute to get a sense of the international breakdown of cards you've collected.
   */
  country?: (string | null)
  /**
   * Two-digit number representing the card's expiration month.
   */
  exp_month: number
  /**
   * Four-digit number representing the card's expiration year.
   */
  exp_year: number
  /**
   * Uniquely identifies this particular card number. You can use this attribute to check whether two customers who’ve signed up with you are using the same card number, for example. For payment methods that tokenize card information (Apple Pay, Google Pay), the tokenized number might be provided instead of the underlying card number.
   * 
   * *Starting May 1, 2021, card fingerprint in India for Connect will change to allow two fingerprints for the same card --- one for India and one for the rest of the world.*
   */
  fingerprint?: (string | null)
  /**
   * Card funding type. Can be `credit`, `debit`, `prepaid`, or `unknown`.
   */
  funding: string
  /**
   * Details of the original PaymentMethod that created this object.
   */
  generated_from?: (PaymentMethodCardGeneratedCard | null)
  /**
   * The last four digits of the card.
   */
  last4: string
  /**
   * Contains information about card networks that can be used to process the payment.
   */
  networks?: (Networks | null)
  /**
   * Contains details on how this Card may be used for 3D Secure authentication.
   */
  three_d_secure_usage?: (ThreeDSecureUsage | null)
  /**
   * If this Card is part of a card wallet, this contains the details of the card wallet.
   */
  wallet?: (PaymentMethodCardWallet | null)
}
export interface PaymentMethodCardChecks {
  /**
   * If a address line1 was provided, results of the check, one of `pass`, `fail`, `unavailable`, or `unchecked`.
   */
  address_line1_check?: (string | null)
  /**
   * If a address postal code was provided, results of the check, one of `pass`, `fail`, `unavailable`, or `unchecked`.
   */
  address_postal_code_check?: (string | null)
  /**
   * If a CVC was provided, results of the check, one of `pass`, `fail`, `unavailable`, or `unchecked`.
   */
  cvc_check?: (string | null)
}
export interface PaymentMethodCardGeneratedCard {
  /**
   * The charge that created this object.
   */
  charge?: (string | null)
  /**
   * Transaction-specific details of the payment method used in the payment.
   */
  payment_method_details?: (CardGeneratedFromPaymentMethodDetails | null)
  /**
   * The ID of the SetupAttempt that generated this PaymentMethod, if any.
   */
  setup_attempt?: (string | PaymentFlowsSetupIntentSetupAttempt | null)
}
export interface CardGeneratedFromPaymentMethodDetails {
  card_present?: PaymentMethodDetailsCardPresent
  /**
   * The type of payment method transaction-specific details from the transaction that generated this `card` payment method. Always `card_present`.
   */
  type: string
}
export interface PaymentMethodDetailsCardPresent {
  /**
   * The authorized amount
   */
  amount_authorized?: (number | null)
  /**
   * Card brand. Can be `amex`, `diners`, `discover`, `jcb`, `mastercard`, `unionpay`, `visa`, or `unknown`.
   */
  brand?: (string | null)
  /**
   * When using manual capture, a future timestamp after which the charge will be automatically refunded if uncaptured.
   */
  capture_before?: number
  /**
   * The cardholder name as read from the card, in [ISO 7813](https://en.wikipedia.org/wiki/ISO/IEC_7813) format. May include alphanumeric characters, special characters and first/last name separator (`/`). In some cases, the cardholder name may not be available depending on how the issuer has configured the card. Cardholder name is typically not available on swipe or contactless payments, such as those made with Apple Pay and Google Pay.
   */
  cardholder_name?: (string | null)
  /**
   * Two-letter ISO code representing the country of the card. You could use this attribute to get a sense of the international breakdown of cards you've collected.
   */
  country?: (string | null)
  /**
   * Authorization response cryptogram.
   */
  emv_auth_data?: (string | null)
  /**
   * Two-digit number representing the card's expiration month.
   */
  exp_month: number
  /**
   * Four-digit number representing the card's expiration year.
   */
  exp_year: number
  /**
   * Uniquely identifies this particular card number. You can use this attribute to check whether two customers who’ve signed up with you are using the same card number, for example. For payment methods that tokenize card information (Apple Pay, Google Pay), the tokenized number might be provided instead of the underlying card number.
   * 
   * *Starting May 1, 2021, card fingerprint in India for Connect will change to allow two fingerprints for the same card --- one for India and one for the rest of the world.*
   */
  fingerprint?: (string | null)
  /**
   * Card funding type. Can be `credit`, `debit`, `prepaid`, or `unknown`.
   */
  funding?: (string | null)
  /**
   * ID of a card PaymentMethod generated from the card_present PaymentMethod that may be attached to a Customer for future transactions. Only present if it was possible to generate a card PaymentMethod.
   */
  generated_card?: (string | null)
  /**
   * Whether this [PaymentIntent](https://stripe.com/docs/api/payment_intents) is eligible for incremental authorizations. Request support using [request_incremental_authorization_support](https://stripe.com/docs/api/payment_intents/create#create_payment_intent-payment_method_options-card_present-request_incremental_authorization_support).
   */
  incremental_authorization_supported: boolean
  /**
   * The last four digits of the card.
   */
  last4?: (string | null)
  /**
   * Identifies which network this charge was processed on. Can be `amex`, `cartes_bancaires`, `diners`, `discover`, `interac`, `jcb`, `mastercard`, `unionpay`, `visa`, or `unknown`.
   */
  network?: (string | null)
  /**
   * Defines whether the authorized amount can be over-captured or not
   */
  overcapture_supported: boolean
  /**
   * How card details were read in this transaction.
   */
  read_method?: ("contact_emv" | "contactless_emv" | "contactless_magstripe_mode" | "magnetic_stripe_fallback" | "magnetic_stripe_track2" | null)
  /**
   * A collection of fields required to be displayed on receipts. Only required for EMV transactions.
   */
  receipt?: (PaymentMethodDetailsCardPresentReceipt | null)
}
export interface PaymentMethodDetailsCardPresentReceipt {
  /**
   * The type of account being debited or credited
   */
  account_type?: ("checking" | "credit" | "prepaid" | "unknown")
  /**
   * EMV tag 9F26, cryptogram generated by the integrated circuit chip.
   */
  application_cryptogram?: (string | null)
  /**
   * Mnenomic of the Application Identifier.
   */
  application_preferred_name?: (string | null)
  /**
   * Identifier for this transaction.
   */
  authorization_code?: (string | null)
  /**
   * EMV tag 8A. A code returned by the card issuer.
   */
  authorization_response_code?: (string | null)
  /**
   * How the cardholder verified ownership of the card.
   */
  cardholder_verification_method?: (string | null)
  /**
   * EMV tag 84. Similar to the application identifier stored on the integrated circuit chip.
   */
  dedicated_file_name?: (string | null)
  /**
   * The outcome of a series of EMV functions performed by the card reader.
   */
  terminal_verification_results?: (string | null)
  /**
   * An indication of various EMV functions performed during the transaction.
   */
  transaction_status_information?: (string | null)
}
/**
 * A SetupAttempt describes one attempted confirmation of a SetupIntent,
 * whether that confirmation was successful or unsuccessful. You can use
 * SetupAttempts to inspect details of a specific attempt at setting up a
 * payment method using a SetupIntent.
 */
export interface PaymentFlowsSetupIntentSetupAttempt {
  /**
   * The value of [application](https://stripe.com/docs/api/setup_intents/object#setup_intent_object-application) on the SetupIntent at the time of this confirmation.
   */
  application?: (string | Application | null)
  /**
   * If present, the SetupIntent's payment method will be attached to the in-context Stripe Account.
   * 
   * It can only be used for this Stripe Account’s own money movement flows like InboundTransfer and OutboundTransfers. It cannot be set to true when setting up a PaymentMethod for a Customer, and defaults to false when attaching a PaymentMethod to a Customer.
   */
  attach_to_self?: boolean
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * The value of [customer](https://stripe.com/docs/api/setup_intents/object#setup_intent_object-customer) on the SetupIntent at the time of this confirmation.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * Indicates the directions of money movement for which this payment method is intended to be used.
   * 
   * Include `inbound` if you intend to use the payment method as the origin to pull funds from. Include `outbound` if you intend to use the payment method as the destination to send funds to. You can include both if you intend to use the payment method for both purposes.
   */
  flow_directions?: (("inbound" | "outbound")[] | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "setup_attempt"
  /**
   * The value of [on_behalf_of](https://stripe.com/docs/api/setup_intents/object#setup_intent_object-on_behalf_of) on the SetupIntent at the time of this confirmation.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * ID of the payment method used with this SetupAttempt.
   */
  payment_method: (string | PaymentMethod)
  payment_method_details: SetupAttemptPaymentMethodDetails
  /**
   * The error encountered during this attempt to confirm the SetupIntent, if any.
   */
  setup_error?: (APIErrors | null)
  /**
   * ID of the SetupIntent that this attempt belongs to.
   */
  setup_intent: (string | SetupIntent)
  /**
   * Status of this SetupAttempt, one of `requires_confirmation`, `requires_action`, `processing`, `succeeded`, `failed`, or `abandoned`.
   */
  status: string
  /**
   * The value of [usage](https://stripe.com/docs/api/setup_intents/object#setup_intent_object-usage) on the SetupIntent at the time of this confirmation, one of `off_session` or `on_session`.
   */
  usage: string
}
export interface Application {
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The name of the application.
   */
  name?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "application"
}
export interface SetupAttemptPaymentMethodDetails {
  acss_debit?: SetupAttemptPaymentMethodDetailsAcssDebit
  au_becs_debit?: SetupAttemptPaymentMethodDetailsAuBecsDebit
  bacs_debit?: SetupAttemptPaymentMethodDetailsBacsDebit
  bancontact?: SetupAttemptPaymentMethodDetailsBancontact
  blik?: SetupAttemptPaymentMethodDetailsBlik
  boleto?: SetupAttemptPaymentMethodDetailsBoleto
  card?: SetupAttemptPaymentMethodDetailsCard
  card_present?: SetupAttemptPaymentMethodDetailsCardPresent
  ideal?: SetupAttemptPaymentMethodDetailsIdeal
  klarna?: SetupAttemptPaymentMethodDetailsKlarna
  link?: SetupAttemptPaymentMethodDetailsLink
  sepa_debit?: SetupAttemptPaymentMethodDetailsSepaDebit
  sofort?: SetupAttemptPaymentMethodDetailsSofort
  /**
   * The type of the payment method used in the SetupIntent (e.g., `card`). An additional hash is included on `payment_method_details` with a name matching this value. It contains confirmation-specific information for the payment method.
   */
  type: string
  us_bank_account?: SetupAttemptPaymentMethodDetailsUsBankAccount
}
export interface SetupAttemptPaymentMethodDetailsAcssDebit {

}
export interface SetupAttemptPaymentMethodDetailsAuBecsDebit {

}
export interface SetupAttemptPaymentMethodDetailsBacsDebit {

}
export interface SetupAttemptPaymentMethodDetailsBancontact {
  /**
   * Bank code of bank associated with the bank account.
   */
  bank_code?: (string | null)
  /**
   * Name of the bank associated with the bank account.
   */
  bank_name?: (string | null)
  /**
   * Bank Identifier Code of the bank associated with the bank account.
   */
  bic?: (string | null)
  /**
   * The ID of the SEPA Direct Debit PaymentMethod which was generated by this SetupAttempt.
   */
  generated_sepa_debit?: (string | PaymentMethod | null)
  /**
   * The mandate for the SEPA Direct Debit PaymentMethod which was generated by this SetupAttempt.
   */
  generated_sepa_debit_mandate?: (string | Mandate | null)
  /**
   * Last four characters of the IBAN.
   */
  iban_last4?: (string | null)
  /**
   * Preferred language of the Bancontact authorization page that the customer is redirected to.
   * Can be one of `en`, `de`, `fr`, or `nl`
   */
  preferred_language?: ("de" | "en" | "fr" | "nl" | null)
  /**
   * Owner's verified full name. Values are verified or provided by Bancontact directly
   * (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_name?: (string | null)
}
/**
 * A Mandate is a record of the permission a customer has given you to debit their payment method.
 */
export interface Mandate {
  customer_acceptance: CustomerAcceptance
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  multi_use?: MandateMultiUse
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "mandate"
  /**
   * ID of the payment method associated with this mandate.
   */
  payment_method: (string | PaymentMethod)
  payment_method_details: MandatePaymentMethodDetails
  single_use?: MandateSingleUse
  /**
   * The status of the mandate, which indicates whether it can be used to initiate a payment.
   */
  status: ("active" | "inactive" | "pending")
  /**
   * The type of the mandate.
   */
  type: ("multi_use" | "single_use")
}
export interface CustomerAcceptance {
  /**
   * The time at which the customer accepted the Mandate.
   */
  accepted_at?: (number | null)
  offline?: OfflineAcceptance
  online?: OnlineAcceptance
  /**
   * The type of customer acceptance information included with the Mandate. One of `online` or `offline`.
   */
  type: ("offline" | "online")
}
export interface OfflineAcceptance {

}
export interface OnlineAcceptance {
  /**
   * The IP address from which the Mandate was accepted by the customer.
   */
  ip_address?: (string | null)
  /**
   * The user agent of the browser from which the Mandate was accepted by the customer.
   */
  user_agent?: (string | null)
}
export interface MandateMultiUse {

}
export interface MandatePaymentMethodDetails {
  acss_debit?: MandateAcssDebit
  au_becs_debit?: MandateAuBecsDebit
  bacs_debit?: MandateBacsDebit
  blik?: MandateBlik
  card?: CardMandatePaymentMethodDetails
  link?: MandateLink
  sepa_debit?: MandateSepaDebit
  /**
   * The type of the payment method associated with this mandate. An additional hash is included on `payment_method_details` with a name matching this value. It contains mandate information specific to the payment method.
   */
  type: string
  us_bank_account?: MandateUsBankAccount
}
export interface MandateAcssDebit {
  /**
   * List of Stripe products where this mandate can be selected automatically.
   */
  default_for?: ("invoice" | "subscription")[]
  /**
   * Description of the interval. Only required if the 'payment_schedule' parameter is 'interval' or 'combined'.
   */
  interval_description?: (string | null)
  /**
   * Payment schedule for the mandate.
   */
  payment_schedule: ("combined" | "interval" | "sporadic")
  /**
   * Transaction type of the mandate.
   */
  transaction_type: ("business" | "personal")
}
export interface MandateAuBecsDebit {
  /**
   * The URL of the mandate. This URL generally contains sensitive information about the customer and should be shared with them exclusively.
   */
  url: string
}
export interface MandateBacsDebit {
  /**
   * The status of the mandate on the Bacs network. Can be one of `pending`, `revoked`, `refused`, or `accepted`.
   */
  network_status: ("accepted" | "pending" | "refused" | "revoked")
  /**
   * The unique reference identifying the mandate on the Bacs network.
   */
  reference: string
  /**
   * The URL that will contain the mandate that the customer has signed.
   */
  url: string
}
export interface MandateBlik {
  /**
   * Date at which the mandate expires.
   */
  expires_after?: (number | null)
  off_session?: MandateOptionsOffSessionDetailsBlik
  /**
   * Type of the mandate.
   */
  type?: ("off_session" | "on_session" | null)
}
export interface MandateOptionsOffSessionDetailsBlik {
  /**
   * Amount of each recurring payment.
   */
  amount?: (number | null)
  /**
   * Currency of each recurring payment.
   */
  currency?: (string | null)
  /**
   * Frequency interval of each recurring payment.
   */
  interval?: ("day" | "month" | "week" | "year" | null)
  /**
   * Frequency indicator of each recurring payment.
   */
  interval_count?: (number | null)
}
export interface CardMandatePaymentMethodDetails {

}
export interface MandateLink {

}
export interface MandateSepaDebit {
  /**
   * The unique reference of the mandate.
   */
  reference: string
  /**
   * The URL of the mandate. This URL generally contains sensitive information about the customer and should be shared with them exclusively.
   */
  url: string
}
export interface MandateUsBankAccount {

}
export interface MandateSingleUse {
  /**
   * On a single use mandate, the amount of the payment.
   */
  amount: number
  /**
   * On a single use mandate, the currency of the payment.
   */
  currency: string
}
export interface SetupAttemptPaymentMethodDetailsBlik {

}
export interface SetupAttemptPaymentMethodDetailsBoleto {

}
export interface SetupAttemptPaymentMethodDetailsCard {
  /**
   * Populated if this authorization used 3D Secure authentication.
   */
  three_d_secure?: (ThreeDSecureDetails | null)
}
export interface ThreeDSecureDetails {
  /**
   * For authenticated transactions: how the customer was authenticated by
   * the issuing bank.
   */
  authentication_flow?: ("challenge" | "frictionless" | null)
  /**
   * Indicates the outcome of 3D Secure authentication.
   */
  result?: ("attempt_acknowledged" | "authenticated" | "exempted" | "failed" | "not_supported" | "processing_error" | null)
  /**
   * Additional information about why 3D Secure succeeded or failed based
   * on the `result`.
   */
  result_reason?: ("abandoned" | "bypassed" | "canceled" | "card_not_enrolled" | "network_not_supported" | "protocol_error" | "rejected" | null)
  /**
   * The version of 3D Secure that was used.
   */
  version?: ("1.0.2" | "2.1.0" | "2.2.0" | null)
}
export interface SetupAttemptPaymentMethodDetailsCardPresent {
  /**
   * The ID of the Card PaymentMethod which was generated by this SetupAttempt.
   */
  generated_card?: (string | PaymentMethod | null)
}
export interface SetupAttemptPaymentMethodDetailsIdeal {
  /**
   * The customer's bank. Can be one of `abn_amro`, `asn_bank`, `bunq`, `handelsbanken`, `ing`, `knab`, `moneyou`, `rabobank`, `regiobank`, `revolut`, `sns_bank`, `triodos_bank`, `van_lanschot`, or `yoursafe`.
   */
  bank?: ("abn_amro" | "asn_bank" | "bunq" | "handelsbanken" | "ing" | "knab" | "moneyou" | "rabobank" | "regiobank" | "revolut" | "sns_bank" | "triodos_bank" | "van_lanschot" | "yoursafe" | null)
  /**
   * The Bank Identifier Code of the customer's bank.
   */
  bic?: ("ABNANL2A" | "ASNBNL21" | "BITSNL2A" | "BUNQNL2A" | "FVLBNL22" | "HANDNL2A" | "INGBNL2A" | "KNABNL2H" | "MOYONL21" | "RABONL2U" | "RBRBNL21" | "REVOLT21" | "SNSBNL2A" | "TRIONL2U" | null)
  /**
   * The ID of the SEPA Direct Debit PaymentMethod which was generated by this SetupAttempt.
   */
  generated_sepa_debit?: (string | PaymentMethod | null)
  /**
   * The mandate for the SEPA Direct Debit PaymentMethod which was generated by this SetupAttempt.
   */
  generated_sepa_debit_mandate?: (string | Mandate | null)
  /**
   * Last four characters of the IBAN.
   */
  iban_last4?: (string | null)
  /**
   * Owner's verified full name. Values are verified or provided by iDEAL directly
   * (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_name?: (string | null)
}
export interface SetupAttemptPaymentMethodDetailsKlarna {

}
export interface SetupAttemptPaymentMethodDetailsLink {

}
export interface SetupAttemptPaymentMethodDetailsSepaDebit {

}
export interface SetupAttemptPaymentMethodDetailsSofort {
  /**
   * Bank code of bank associated with the bank account.
   */
  bank_code?: (string | null)
  /**
   * Name of the bank associated with the bank account.
   */
  bank_name?: (string | null)
  /**
   * Bank Identifier Code of the bank associated with the bank account.
   */
  bic?: (string | null)
  /**
   * The ID of the SEPA Direct Debit PaymentMethod which was generated by this SetupAttempt.
   */
  generated_sepa_debit?: (string | PaymentMethod | null)
  /**
   * The mandate for the SEPA Direct Debit PaymentMethod which was generated by this SetupAttempt.
   */
  generated_sepa_debit_mandate?: (string | Mandate | null)
  /**
   * Last four characters of the IBAN.
   */
  iban_last4?: (string | null)
  /**
   * Preferred language of the Sofort authorization page that the customer is redirected to.
   * Can be one of `en`, `de`, `fr`, or `nl`
   */
  preferred_language?: ("de" | "en" | "fr" | "nl" | null)
  /**
   * Owner's verified full name. Values are verified or provided by Sofort directly
   * (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_name?: (string | null)
}
export interface SetupAttemptPaymentMethodDetailsUsBankAccount {

}
export interface APIErrors {
  /**
   * For card errors, the ID of the failed charge.
   */
  charge?: string
  /**
   * For some errors that could be handled programmatically, a short string indicating the [error code](https://stripe.com/docs/error-codes) reported.
   */
  code?: string
  /**
   * For card errors resulting from a card issuer decline, a short string indicating the [card issuer's reason for the decline](https://stripe.com/docs/declines#issuer-declines) if they provide one.
   */
  decline_code?: string
  /**
   * A URL to more information about the [error code](https://stripe.com/docs/error-codes) reported.
   */
  doc_url?: string
  /**
   * A human-readable message providing more details about the error. For card errors, these messages can be shown to your users.
   */
  message?: string
  /**
   * If the error is parameter-specific, the parameter related to the error. For example, you can use this to display a message near the correct form field.
   */
  param?: string
  payment_intent?: PaymentIntent
  payment_method?: PaymentMethod
  /**
   * If the error is specific to the type of payment method, the payment method type that had a problem. This field is only populated for invoice-related errors.
   */
  payment_method_type?: string
  /**
   * A URL to the request log entry in your dashboard.
   */
  request_log_url?: string
  setup_intent?: SetupIntent
  /**
   * The source object for errors returned on a request involving a source.
   */
  source?: (BankAccount | Card | Source)
  /**
   * The type of error returned. One of `api_error`, `card_error`, `idempotency_error`, or `invalid_request_error`
   */
  type: ("api_error" | "card_error" | "idempotency_error" | "invalid_request_error")
}
/**
 * A PaymentIntent guides you through the process of collecting a payment from your customer.
 * We recommend that you create exactly one PaymentIntent for each order or
 * customer session in your system. You can reference the PaymentIntent later to
 * see the history of payment attempts for a particular session.
 * 
 * A PaymentIntent transitions through
 * [multiple statuses](https://stripe.com/docs/payments/intents#intent-statuses)
 * throughout its lifetime as it interfaces with Stripe.js to perform
 * authentication flows and ultimately creates at most one successful charge.
 * 
 * Related guide: [Payment Intents API](https://stripe.com/docs/payments/payment-intents).
 */
export interface PaymentIntent {
  /**
   * Amount intended to be collected by this PaymentIntent. A positive integer representing how much to charge in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal) (e.g., 100 cents to charge $1.00 or 100 to charge ¥100, a zero-decimal currency). The minimum amount is $0.50 US or [equivalent in charge currency](https://stripe.com/docs/currencies#minimum-and-maximum-charge-amounts). The amount value supports up to eight digits (e.g., a value of 99999999 for a USD charge of $999,999.99).
   */
  amount: number
  /**
   * Amount that can be captured from this PaymentIntent.
   */
  amount_capturable?: number
  amount_details?: PaymentFlowsAmountDetails
  /**
   * Amount that was collected by this PaymentIntent.
   */
  amount_received?: number
  /**
   * ID of the Connect application that created the PaymentIntent.
   */
  application?: (string | Application | null)
  /**
   * The amount of the application fee (if any) that will be requested to be applied to the payment and transferred to the application owner's Stripe account. The amount of the application fee collected will be capped at the total payment amount. For more information, see the PaymentIntents [use case for connected accounts](https://stripe.com/docs/payments/connected-accounts).
   */
  application_fee_amount?: (number | null)
  /**
   * Settings to configure compatible payment methods from the [Stripe Dashboard](https://dashboard.stripe.com/settings/payment_methods)
   */
  automatic_payment_methods?: (PaymentFlowsAutomaticPaymentMethodsPaymentIntent | null)
  /**
   * Populated when `status` is `canceled`, this is the time at which the PaymentIntent was canceled. Measured in seconds since the Unix epoch.
   */
  canceled_at?: (number | null)
  /**
   * Reason for cancellation of this PaymentIntent, either user-provided (`duplicate`, `fraudulent`, `requested_by_customer`, or `abandoned`) or generated by Stripe internally (`failed_invoice`, `void_invoice`, or `automatic`).
   */
  cancellation_reason?: ("abandoned" | "automatic" | "duplicate" | "failed_invoice" | "fraudulent" | "requested_by_customer" | "void_invoice" | null)
  /**
   * Controls when the funds will be captured from the customer's account.
   */
  capture_method: ("automatic" | "manual")
  /**
   * The client secret of this PaymentIntent. Used for client-side retrieval using a publishable key. 
   * 
   * The client secret can be used to complete a payment from your frontend. It should not be stored, logged, or exposed to anyone other than the customer. Make sure that you have TLS enabled on any page that includes the client secret.
   * 
   * Refer to our docs to [accept a payment](https://stripe.com/docs/payments/accept-a-payment?ui=elements) and learn about how `client_secret` should be handled.
   */
  client_secret?: (string | null)
  confirmation_method: ("automatic" | "manual")
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * ID of the Customer this PaymentIntent belongs to, if one exists.
   * 
   * Payment methods attached to other Customers cannot be used with this PaymentIntent.
   * 
   * If present in combination with [setup_future_usage](https://stripe.com/docs/api#payment_intent_object-setup_future_usage), this PaymentIntent's payment method will be attached to the Customer after the PaymentIntent has been confirmed and any required actions from the user are complete.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * ID of the invoice that created this PaymentIntent, if it exists.
   */
  invoice?: (string | Invoice | null)
  /**
   * The payment error encountered in the previous PaymentIntent confirmation. It will be cleared if the PaymentIntent is later updated for any reason.
   */
  last_payment_error?: (APIErrors | null)
  /**
   * The latest charge created by this payment intent.
   */
  latest_charge?: (string | Charge | null)
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format. For more information, see the [documentation](https://stripe.com/docs/payments/payment-intents/creating-payment-intents#storing-information-in-metadata).
   */
  metadata?: {
    [k: string]: string
  }
  /**
   * If present, this property tells you what actions you need to take in order for your customer to fulfill a payment using the provided source.
   */
  next_action?: (PaymentIntentNextAction | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "payment_intent"
  /**
   * The account (if any) for which the funds of the PaymentIntent are intended. See the PaymentIntents [use case for connected accounts](https://stripe.com/docs/payments/connected-accounts) for details.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * ID of the payment method used in this PaymentIntent.
   */
  payment_method?: (string | PaymentMethod | null)
  /**
   * Payment-method-specific configuration for this PaymentIntent.
   */
  payment_method_options?: (PaymentIntentPaymentMethodOptions | null)
  /**
   * The list of payment method types (e.g. card) that this PaymentIntent is allowed to use.
   */
  payment_method_types: string[]
  /**
   * If present, this property tells you about the processing state of the payment.
   */
  processing?: (PaymentIntentProcessing | null)
  /**
   * Email address that the receipt for the resulting payment will be sent to. If `receipt_email` is specified for a payment in live mode, a receipt will be sent regardless of your [email settings](https://dashboard.stripe.com/account/emails).
   */
  receipt_email?: (string | null)
  /**
   * ID of the review associated with this PaymentIntent, if any.
   */
  review?: (string | RadarReview | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("off_session" | "on_session" | null)
  /**
   * Shipping information for this PaymentIntent.
   */
  shipping?: (Shipping | null)
  /**
   * For non-card charges, you can use this value as the complete description that appears on your customers’ statements. Must contain at least one letter, maximum 22 characters.
   */
  statement_descriptor?: (string | null)
  /**
   * Provides information about a card payment that customers see on their statements. Concatenated with the prefix (shortened descriptor) or statement descriptor that’s set on the account to form the complete statement descriptor. Maximum 22 characters for the concatenated descriptor.
   */
  statement_descriptor_suffix?: (string | null)
  /**
   * Status of this PaymentIntent, one of `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, `requires_capture`, `canceled`, or `succeeded`. Read more about each PaymentIntent [status](https://stripe.com/docs/payments/intents#intent-statuses).
   */
  status: ("canceled" | "processing" | "requires_action" | "requires_capture" | "requires_confirmation" | "requires_payment_method" | "succeeded")
  /**
   * The data with which to automatically create a Transfer when the payment is finalized. See the PaymentIntents [use case for connected accounts](https://stripe.com/docs/payments/connected-accounts) for details.
   */
  transfer_data?: (TransferData | null)
  /**
   * A string that identifies the resulting payment as part of a group. See the PaymentIntents [use case for connected accounts](https://stripe.com/docs/payments/connected-accounts) for details.
   */
  transfer_group?: (string | null)
}
export interface PaymentFlowsAmountDetails {
  tip?: PaymentFlowsAmountDetailsResourceTip
}
export interface PaymentFlowsAmountDetailsResourceTip {
  /**
   * Portion of the amount that corresponds to a tip.
   */
  amount?: number
}
export interface PaymentFlowsAutomaticPaymentMethodsPaymentIntent {
  /**
   * Automatically calculates compatible payment methods
   */
  enabled: boolean
}
/**
 * Invoices are statements of amounts owed by a customer, and are either
 * generated one-off, or generated periodically from a subscription.
 * 
 * They contain [invoice items](https://stripe.com/docs/api#invoiceitems), and proration adjustments
 * that may be caused by subscription upgrades/downgrades (if necessary).
 * 
 * If your invoice is configured to be billed through automatic charges,
 * Stripe automatically finalizes your invoice and attempts payment. Note
 * that finalizing the invoice,
 * [when automatic](https://stripe.com/docs/billing/invoices/workflow/#auto_advance), does
 * not happen immediately as the invoice is created. Stripe waits
 * until one hour after the last webhook was successfully sent (or the last
 * webhook timed out after failing). If you (and the platforms you may have
 * connected to) have no webhooks configured, Stripe waits one hour after
 * creation to finalize the invoice.
 * 
 * If your invoice is configured to be billed by sending an email, then based on your
 * [email settings](https://dashboard.stripe.com/account/billing/automatic),
 * Stripe will email the invoice to your customer and await payment. These
 * emails can contain a link to a hosted page to pay the invoice.
 * 
 * Stripe applies any customer credit on the account before determining the
 * amount due for the invoice (i.e., the amount that will be actually
 * charged). If the amount due for the invoice is less than Stripe's [minimum allowed charge
 * per currency](/docs/currencies#minimum-and-maximum-charge-amounts), the
 * invoice is automatically marked paid, and we add the amount due to the
 * customer's credit balance which is applied to the next invoice.
 * 
 * More details on the customer's credit balance are
 * [here](https://stripe.com/docs/billing/customer/balance).
 * 
 * Related guide: [Send Invoices to Customers](https://stripe.com/docs/billing/invoices/sending).
 */
export interface Invoice {
  /**
   * The country of the business associated with this invoice, most often the business creating the invoice.
   */
  account_country?: (string | null)
  /**
   * The public name of the business associated with this invoice, most often the business creating the invoice.
   */
  account_name?: (string | null)
  /**
   * The account tax IDs associated with the invoice. Only editable when the invoice is a draft.
   */
  account_tax_ids?: ((string | TaxId | DeletedTaxId)[] | null)
  /**
   * Final amount due at this time for this invoice. If the invoice's total is smaller than the minimum charge amount, for example, or if there is account credit that can be applied to the invoice, the `amount_due` may be 0. If there is a positive `starting_balance` for the invoice (the customer owes money), the `amount_due` will also take that into account. The charge that gets generated for the invoice will be for the amount specified in `amount_due`.
   */
  amount_due: number
  /**
   * The amount, in %s, that was paid.
   */
  amount_paid: number
  /**
   * The difference between amount_due and amount_paid, in %s.
   */
  amount_remaining: number
  /**
   * This is the sum of all the shipping amounts.
   */
  amount_shipping: number
  /**
   * ID of the Connect Application that created the invoice.
   */
  application?: (string | Application | DeletedApplication | null)
  /**
   * The fee in %s that will be applied to the invoice and transferred to the application owner's Stripe account when the invoice is paid.
   */
  application_fee_amount?: (number | null)
  /**
   * Number of payment attempts made for this invoice, from the perspective of the payment retry schedule. Any payment attempt counts as the first attempt, and subsequently only automatic retries increment the attempt count. In other words, manual payment attempts after the first attempt do not affect the retry schedule.
   */
  attempt_count: number
  /**
   * Whether an attempt has been made to pay the invoice. An invoice is not attempted until 1 hour after the `invoice.created` webhook, for example, so you might not want to display that invoice as unpaid to your users.
   */
  attempted: boolean
  /**
   * Controls whether Stripe will perform [automatic collection](https://stripe.com/docs/billing/invoices/workflow/#auto_advance) of the invoice. When `false`, the invoice's state will not automatically advance without an explicit action.
   */
  auto_advance?: boolean
  automatic_tax: AutomaticTax
  /**
   * Indicates the reason why the invoice was created. `subscription_cycle` indicates an invoice created by a subscription advancing into a new period. `subscription_create` indicates an invoice created due to creating a subscription. `subscription_update` indicates an invoice created due to updating a subscription. `subscription` is set for all old invoices to indicate either a change to a subscription or a period advancement. `manual` is set for all invoices unrelated to a subscription (for example: created via the invoice editor). The `upcoming` value is reserved for simulated invoices per the upcoming invoice endpoint. `subscription_threshold` indicates an invoice created due to a billing threshold being reached.
   */
  billing_reason?: ("automatic_pending_invoice_item_invoice" | "manual" | "quote_accept" | "subscription" | "subscription_create" | "subscription_cycle" | "subscription_threshold" | "subscription_update" | "upcoming" | null)
  /**
   * ID of the latest charge generated for this invoice, if any.
   */
  charge?: (string | Charge | null)
  /**
   * Either `charge_automatically`, or `send_invoice`. When charging automatically, Stripe will attempt to pay this invoice using the default source attached to the customer. When sending an invoice, Stripe will email this invoice to the customer with payment instructions.
   */
  collection_method: ("charge_automatically" | "send_invoice")
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * Custom fields displayed on the invoice.
   */
  custom_fields?: (InvoiceSettingCustomField[] | null)
  /**
   * The ID of the customer who will be billed.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * The customer's address. Until the invoice is finalized, this field will equal `customer.address`. Once the invoice is finalized, this field will no longer be updated.
   */
  customer_address?: (Address | null)
  /**
   * The customer's email. Until the invoice is finalized, this field will equal `customer.email`. Once the invoice is finalized, this field will no longer be updated.
   */
  customer_email?: (string | null)
  /**
   * The customer's name. Until the invoice is finalized, this field will equal `customer.name`. Once the invoice is finalized, this field will no longer be updated.
   */
  customer_name?: (string | null)
  /**
   * The customer's phone number. Until the invoice is finalized, this field will equal `customer.phone`. Once the invoice is finalized, this field will no longer be updated.
   */
  customer_phone?: (string | null)
  /**
   * The customer's shipping information. Until the invoice is finalized, this field will equal `customer.shipping`. Once the invoice is finalized, this field will no longer be updated.
   */
  customer_shipping?: (Shipping | null)
  /**
   * The customer's tax exempt status. Until the invoice is finalized, this field will equal `customer.tax_exempt`. Once the invoice is finalized, this field will no longer be updated.
   */
  customer_tax_exempt?: ("exempt" | "none" | "reverse" | null)
  /**
   * The customer's tax IDs. Until the invoice is finalized, this field will contain the same tax IDs as `customer.tax_ids`. Once the invoice is finalized, this field will no longer be updated.
   */
  customer_tax_ids?: (InvoicesResourceInvoiceTaxID[] | null)
  /**
   * ID of the default payment method for the invoice. It must belong to the customer associated with the invoice. If not set, defaults to the subscription's default payment method, if any, or to the default payment method in the customer's invoice settings.
   */
  default_payment_method?: (string | PaymentMethod | null)
  /**
   * ID of the default payment source for the invoice. It must belong to the customer associated with the invoice and be in a chargeable state. If not set, defaults to the subscription's default source, if any, or to the customer's default source.
   */
  default_source?: (string | BankAccount | Card | Source | null)
  /**
   * The tax rates applied to this invoice, if any.
   */
  default_tax_rates: TaxRate[]
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users. Referenced as 'memo' in the Dashboard.
   */
  description?: (string | null)
  /**
   * Describes the current discount applied to this invoice, if there is one. Not populated if there are multiple discounts.
   */
  discount?: (Discount | null)
  /**
   * The discounts applied to the invoice. Line item discounts are applied before invoice discounts. Use `expand[]=discounts` to expand each discount.
   */
  discounts?: ((string | Discount | DeletedDiscount)[] | null)
  /**
   * The date on which payment for this invoice is due. This value will be `null` for invoices where `collection_method=charge_automatically`.
   */
  due_date?: (number | null)
  /**
   * Ending customer balance after the invoice is finalized. Invoices are finalized approximately an hour after successful webhook delivery or when payment collection is attempted for the invoice. If the invoice has not been finalized yet, this will be null.
   */
  ending_balance?: (number | null)
  /**
   * Footer displayed on the invoice.
   */
  footer?: (string | null)
  /**
   * Details of the invoice that was cloned. See the [revision documentation](https://stripe.com/docs/invoicing/invoice-revisions) for more details.
   */
  from_invoice?: (InvoicesFromInvoice | null)
  /**
   * The URL for the hosted invoice page, which allows customers to view and pay an invoice. If the invoice has not been finalized yet, this will be null.
   */
  hosted_invoice_url?: (string | null)
  /**
   * Unique identifier for the object. This property is always present unless the invoice is an upcoming invoice. See [Retrieve an upcoming invoice](https://stripe.com/docs/api/invoices/upcoming) for more details.
   */
  id?: string
  /**
   * The link to download the PDF for the invoice. If the invoice has not been finalized yet, this will be null.
   */
  invoice_pdf?: (string | null)
  /**
   * The error encountered during the previous attempt to finalize the invoice. This field is cleared when the invoice is successfully finalized.
   */
  last_finalization_error?: (APIErrors | null)
  /**
   * The ID of the most recent non-draft revision of this invoice
   */
  latest_revision?: (string | Invoice | null)
  lines: InvoiceLinesList
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * The time at which payment will next be attempted. This value will be `null` for invoices where `collection_method=send_invoice`.
   */
  next_payment_attempt?: (number | null)
  /**
   * A unique, identifying string that appears on emails sent to the customer for this invoice. This starts with the customer's unique invoice_prefix if it is specified.
   */
  number?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "invoice"
  /**
   * The account (if any) for which the funds of the invoice payment are intended. If set, the invoice will be presented with the branding and support information of the specified account. See the [Invoices with Connect](https://stripe.com/docs/billing/invoices/connect) documentation for details.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * Whether payment was successfully collected for this invoice. An invoice can be paid (most commonly) with a charge or with credit from the customer's account balance.
   */
  paid: boolean
  /**
   * Returns true if the invoice was manually marked paid, returns false if the invoice hasn't been paid yet or was paid on Stripe.
   */
  paid_out_of_band: boolean
  /**
   * The PaymentIntent associated with this invoice. The PaymentIntent is generated when the invoice is finalized, and can then be used to pay the invoice. Note that voiding an invoice will cancel the PaymentIntent.
   */
  payment_intent?: (string | PaymentIntent | null)
  payment_settings: InvoicesPaymentSettings
  /**
   * End of the usage period during which invoice items were added to this invoice.
   */
  period_end: number
  /**
   * Start of the usage period during which invoice items were added to this invoice.
   */
  period_start: number
  /**
   * Total amount of all post-payment credit notes issued for this invoice.
   */
  post_payment_credit_notes_amount: number
  /**
   * Total amount of all pre-payment credit notes issued for this invoice.
   */
  pre_payment_credit_notes_amount: number
  /**
   * The quote this invoice was generated from.
   */
  quote?: (string | Quote | null)
  /**
   * This is the transaction number that appears on email receipts sent for this invoice.
   */
  receipt_number?: (string | null)
  /**
   * Options for invoice PDF rendering.
   */
  rendering_options?: (InvoiceSettingRenderingOptions | null)
  /**
   * The details of the cost of shipping, including the ShippingRate applied on the invoice.
   */
  shipping_cost?: (InvoicesShippingCost | null)
  /**
   * Shipping details for the invoice. The Invoice PDF will use the `shipping_details` value if it is set, otherwise the PDF will render the shipping address from the customer.
   */
  shipping_details?: (Shipping | null)
  /**
   * Starting customer balance before the invoice is finalized. If the invoice has not been finalized yet, this will be the current customer balance. For revision invoices, this also includes any customer balance that was applied to the original invoice.
   */
  starting_balance: number
  /**
   * Extra information about an invoice for the customer's credit card statement.
   */
  statement_descriptor?: (string | null)
  /**
   * The status of the invoice, one of `draft`, `open`, `paid`, `uncollectible`, or `void`. [Learn more](https://stripe.com/docs/billing/invoices/workflow#workflow-overview)
   */
  status?: ("deleted" | "draft" | "open" | "paid" | "uncollectible" | "void" | null)
  status_transitions: InvoicesStatusTransitions
  /**
   * The subscription that this invoice was prepared for, if any.
   */
  subscription?: (string | Subscription | null)
  /**
   * Only set for upcoming invoices that preview prorations. The time used to calculate prorations.
   */
  subscription_proration_date?: number
  /**
   * Total of all subscriptions, invoice items, and prorations on the invoice before any invoice level discount or exclusive tax is applied. Item discounts are already incorporated
   */
  subtotal: number
  /**
   * The integer amount in %s representing the subtotal of the invoice before any invoice level discount or tax is applied. Item discounts are already incorporated
   */
  subtotal_excluding_tax?: (number | null)
  /**
   * The amount of tax on this invoice. This is the sum of all the tax amounts on this invoice.
   */
  tax?: (number | null)
  /**
   * ID of the test clock this invoice belongs to.
   */
  test_clock?: (string | TestClock | null)
  threshold_reason?: InvoiceThresholdReason
  /**
   * Total after discounts and taxes.
   */
  total: number
  /**
   * The aggregate amounts calculated per discount across all line items.
   */
  total_discount_amounts?: (DiscountsResourceDiscountAmount[] | null)
  /**
   * The integer amount in %s representing the total amount of the invoice including all discounts but excluding all tax.
   */
  total_excluding_tax?: (number | null)
  /**
   * The aggregate amounts calculated per tax rate for all line items.
   */
  total_tax_amounts: InvoiceTaxAmount[]
  /**
   * The account (if any) the payment will be attributed to for tax reporting, and where funds from the payment will be transferred to for the invoice.
   */
  transfer_data?: (InvoiceTransferData | null)
  /**
   * Invoices are automatically paid or sent 1 hour after webhooks are delivered, or until all webhook delivery attempts have [been exhausted](https://stripe.com/docs/billing/webhooks#understand). This field tracks the time when webhooks for this invoice were successfully delivered. If the invoice had no webhooks to deliver, this will be set while the invoice is being created.
   */
  webhooks_delivered_at?: (number | null)
}
/**
 * You can add one or multiple tax IDs to a [customer](https://stripe.com/docs/api/customers).
 * A customer's tax IDs are displayed on invoices and credit notes issued for the customer.
 * 
 * Related guide: [Customer Tax Identification Numbers](https://stripe.com/docs/billing/taxes/tax-ids).
 */
export interface TaxId {
  /**
   * Two-letter ISO code representing the country of the tax ID.
   */
  country?: (string | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * ID of the customer.
   */
  customer?: (string | Customer | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "tax_id"
  /**
   * Type of the tax ID, one of `ae_trn`, `au_abn`, `au_arn`, `bg_uic`, `br_cnpj`, `br_cpf`, `ca_bn`, `ca_gst_hst`, `ca_pst_bc`, `ca_pst_mb`, `ca_pst_sk`, `ca_qst`, `ch_vat`, `cl_tin`, `eg_tin`, `es_cif`, `eu_oss_vat`, `eu_vat`, `gb_vat`, `ge_vat`, `hk_br`, `hu_tin`, `id_npwp`, `il_vat`, `in_gst`, `is_vat`, `jp_cn`, `jp_rn`, `jp_trn`, `ke_pin`, `kr_brn`, `li_uid`, `mx_rfc`, `my_frp`, `my_itn`, `my_sst`, `no_vat`, `nz_gst`, `ph_tin`, `ru_inn`, `ru_kpp`, `sa_vat`, `sg_gst`, `sg_uen`, `si_tin`, `th_vat`, `tr_tin`, `tw_vat`, `ua_vat`, `us_ein`, or `za_vat`. Note that some legacy tax IDs have type `unknown`
   */
  type: ("ae_trn" | "au_abn" | "au_arn" | "bg_uic" | "br_cnpj" | "br_cpf" | "ca_bn" | "ca_gst_hst" | "ca_pst_bc" | "ca_pst_mb" | "ca_pst_sk" | "ca_qst" | "ch_vat" | "cl_tin" | "eg_tin" | "es_cif" | "eu_oss_vat" | "eu_vat" | "gb_vat" | "ge_vat" | "hk_br" | "hu_tin" | "id_npwp" | "il_vat" | "in_gst" | "is_vat" | "jp_cn" | "jp_rn" | "jp_trn" | "ke_pin" | "kr_brn" | "li_uid" | "mx_rfc" | "my_frp" | "my_itn" | "my_sst" | "no_vat" | "nz_gst" | "ph_tin" | "ru_inn" | "ru_kpp" | "sa_vat" | "sg_gst" | "sg_uen" | "si_tin" | "th_vat" | "tr_tin" | "tw_vat" | "ua_vat" | "unknown" | "us_ein" | "za_vat")
  /**
   * Value of the tax ID.
   */
  value: string
  /**
   * Tax ID verification information.
   */
  verification?: (TaxIdVerification | null)
}
export interface TaxIdVerification {
  /**
   * Verification status, one of `pending`, `verified`, `unverified`, or `unavailable`.
   */
  status: ("pending" | "unavailable" | "unverified" | "verified")
  /**
   * Verified address.
   */
  verified_address?: (string | null)
  /**
   * Verified name.
   */
  verified_name?: (string | null)
}
export interface DeletedTaxId {
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "tax_id"
}
export interface DeletedApplication {
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The name of the application.
   */
  name?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "application"
}
export interface AutomaticTax {
  /**
   * Whether Stripe automatically computes tax on this invoice. Note that incompatible invoice items (invoice items with manually specified [tax rates](https://stripe.com/docs/api/tax_rates), negative amounts, or `tax_behavior=unspecified`) cannot be added to automatic tax invoices.
   */
  enabled: boolean
  /**
   * The status of the most recent automated tax calculation for this invoice.
   */
  status?: ("complete" | "failed" | "requires_location_inputs" | null)
}
/**
 * To charge a credit or a debit card, you create a `Charge` object. You can
 * retrieve and refund individual charges as well as list all charges. Charges
 * are identified by a unique, random ID.
 * 
 * Related guide: [Accept a payment with the Charges API](https://stripe.com/docs/payments/accept-a-payment-charges).
 */
export interface Charge {
  /**
   * Amount intended to be collected by this payment. A positive integer representing how much to charge in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal) (e.g., 100 cents to charge $1.00 or 100 to charge ¥100, a zero-decimal currency). The minimum amount is $0.50 US or [equivalent in charge currency](https://stripe.com/docs/currencies#minimum-and-maximum-charge-amounts). The amount value supports up to eight digits (e.g., a value of 99999999 for a USD charge of $999,999.99).
   */
  amount: number
  /**
   * Amount in %s captured (can be less than the amount attribute on the charge if a partial capture was made).
   */
  amount_captured: number
  /**
   * Amount in %s refunded (can be less than the amount attribute on the charge if a partial refund was issued).
   */
  amount_refunded: number
  /**
   * ID of the Connect application that created the charge.
   */
  application?: (string | Application | null)
  /**
   * The application fee (if any) for the charge. [See the Connect documentation](https://stripe.com/docs/connect/direct-charges#collecting-fees) for details.
   */
  application_fee?: (string | PlatformFee | null)
  /**
   * The amount of the application fee (if any) requested for the charge. [See the Connect documentation](https://stripe.com/docs/connect/direct-charges#collecting-fees) for details.
   */
  application_fee_amount?: (number | null)
  /**
   * ID of the balance transaction that describes the impact of this charge on your account balance (not including refunds or disputes).
   */
  balance_transaction?: (string | BalanceTransaction | null)
  billing_details: BillingDetails
  /**
   * The full statement descriptor that is passed to card networks, and that is displayed on your customers' credit card and bank statements. Allows you to see what the statement descriptor looks like after the static and dynamic portions are combined.
   */
  calculated_statement_descriptor?: (string | null)
  /**
   * If the charge was created without capturing, this Boolean represents whether it is still uncaptured or has since been captured.
   */
  captured: boolean
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * ID of the customer this charge is for if one exists.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * Whether the charge has been disputed.
   */
  disputed: boolean
  /**
   * ID of the balance transaction that describes the reversal of the balance on your account due to payment failure.
   */
  failure_balance_transaction?: (string | BalanceTransaction | null)
  /**
   * Error code explaining reason for charge failure if available (see [the errors section](https://stripe.com/docs/error-codes) for a list of codes).
   */
  failure_code?: (string | null)
  /**
   * Message to user further explaining reason for charge failure if available.
   */
  failure_message?: (string | null)
  /**
   * Information on fraud assessments for the charge.
   */
  fraud_details?: (ChargeFraudDetails | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * ID of the invoice this charge is for if one exists.
   */
  invoice?: (string | Invoice | null)
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "charge"
  /**
   * The account (if any) the charge was made on behalf of without triggering an automatic transfer. See the [Connect documentation](https://stripe.com/docs/connect/charges-transfers) for details.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * Details about whether the payment was accepted, and why. See [understanding declines](https://stripe.com/docs/declines) for details.
   */
  outcome?: (ChargeOutcome | null)
  /**
   * `true` if the charge succeeded, or was successfully authorized for later capture.
   */
  paid: boolean
  /**
   * ID of the PaymentIntent associated with this charge, if one exists.
   */
  payment_intent?: (string | PaymentIntent | null)
  /**
   * ID of the payment method used in this charge.
   */
  payment_method?: (string | null)
  /**
   * Details about the payment method at the time of the transaction.
   */
  payment_method_details?: (PaymentMethodDetails | null)
  radar_options?: RadarRadarOptions
  /**
   * This is the email address that the receipt for this charge was sent to.
   */
  receipt_email?: (string | null)
  /**
   * This is the transaction number that appears on email receipts sent for this charge. This attribute will be `null` until a receipt has been sent.
   */
  receipt_number?: (string | null)
  /**
   * This is the URL to view the receipt for this charge. The receipt is kept up-to-date to the latest state of the charge, including any refunds. If the charge is for an Invoice, the receipt will be stylized as an Invoice receipt.
   */
  receipt_url?: (string | null)
  /**
   * Whether the charge has been fully refunded. If the charge is only partially refunded, this attribute will still be false.
   */
  refunded: boolean
  refunds?: RefundList
  /**
   * ID of the review associated with this charge if one exists.
   */
  review?: (string | RadarReview | null)
  /**
   * Shipping information for the charge.
   */
  shipping?: (Shipping | null)
  /**
   * The transfer ID which created this charge. Only present if the charge came from another Stripe account. [See the Connect documentation](https://stripe.com/docs/connect/destination-charges) for details.
   */
  source_transfer?: (string | Transfer | null)
  /**
   * For card charges, use `statement_descriptor_suffix` instead. Otherwise, you can use this value as the complete description of a charge on your customers’ statements. Must contain at least one letter, maximum 22 characters.
   */
  statement_descriptor?: (string | null)
  /**
   * Provides information about the charge that customers see on their statements. Concatenated with the prefix (shortened descriptor) or statement descriptor that’s set on the account to form the complete statement descriptor. Maximum 22 characters for the concatenated descriptor.
   */
  statement_descriptor_suffix?: (string | null)
  /**
   * The status of the payment is either `succeeded`, `pending`, or `failed`.
   */
  status: ("failed" | "pending" | "succeeded")
  /**
   * ID of the transfer to the `destination` account (only applicable if the charge was created using the `destination` parameter).
   */
  transfer?: (string | Transfer)
  /**
   * An optional dictionary including the account to automatically transfer to as part of a destination charge. [See the Connect documentation](https://stripe.com/docs/connect/destination-charges) for details.
   */
  transfer_data?: (ChargeTransferData | null)
  /**
   * A string that identifies this transaction as part of a group. See the [Connect documentation](https://stripe.com/docs/connect/charges-transfers#transfer-options) for details.
   */
  transfer_group?: (string | null)
}
export interface PlatformFee {
  /**
   * ID of the Stripe account this fee was taken from.
   */
  account: (string | Account)
  /**
   * Amount earned, in %s.
   */
  amount: number
  /**
   * Amount in %s refunded (can be less than the amount attribute on the fee if a partial refund was issued)
   */
  amount_refunded: number
  /**
   * ID of the Connect application that earned the fee.
   */
  application: (string | Application)
  /**
   * Balance transaction that describes the impact of this collected application fee on your account balance (not including refunds).
   */
  balance_transaction?: (string | BalanceTransaction | null)
  /**
   * ID of the charge that the application fee was taken from.
   */
  charge: (string | Charge)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "application_fee"
  /**
   * ID of the corresponding charge on the platform account, if this fee was the result of a charge using the `destination` parameter.
   */
  originating_transaction?: (string | Charge | null)
  /**
   * Whether the fee has been fully refunded. If the fee is only partially refunded, this attribute will still be false.
   */
  refunded: boolean
  refunds: FeeRefundList
}
/**
 * Balance transactions represent funds moving through your Stripe account.
 * They're created for every type of transaction that comes into or flows out of your Stripe account balance.
 * 
 * Related guide: [Balance Transaction Types](https://stripe.com/docs/reports/balance-transaction-types).
 */
export interface BalanceTransaction {
  /**
   * Gross amount of the transaction, in %s.
   */
  amount: number
  /**
   * The date the transaction's net funds will become available in the Stripe balance.
   */
  available_on: number
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * The exchange rate used, if applicable, for this transaction. Specifically, if money was converted from currency A to currency B, then the `amount` in currency A, times `exchange_rate`, would be the `amount` in currency B. For example, suppose you charged a customer 10.00 EUR. Then the PaymentIntent's `amount` would be `1000` and `currency` would be `eur`. Suppose this was converted into 12.34 USD in your Stripe account. Then the BalanceTransaction's `amount` would be `1234`, `currency` would be `usd`, and `exchange_rate` would be `1.234`.
   */
  exchange_rate?: (number | null)
  /**
   * Fees (in %s) paid for this transaction.
   */
  fee: number
  /**
   * Detailed breakdown of fees (in %s) paid for this transaction.
   */
  fee_details: Fee[]
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Net amount of the transaction, in %s.
   */
  net: number
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "balance_transaction"
  /**
   * [Learn more](https://stripe.com/docs/reports/reporting-categories) about how reporting categories can help you understand balance transactions from an accounting perspective.
   */
  reporting_category: string
  /**
   * The Stripe object to which this transaction is related.
   */
  source?: (string | PlatformFee | Charge | ConnectCollectionTransfer | Dispute | FeeRefund | IssuingAuthorization | IssuingDispute | IssuingTransaction | Payout | PlatformTax | Refund | ReserveTransaction | TaxDeductedAtSource | Topup | Transfer | TransferReversal | null)
  /**
   * If the transaction's net funds are available in the Stripe balance yet. Either `available` or `pending`.
   */
  status: string
  /**
   * Transaction type: `adjustment`, `advance`, `advance_funding`, `anticipation_repayment`, `application_fee`, `application_fee_refund`, `charge`, `connect_collection_transfer`, `contribution`, `issuing_authorization_hold`, `issuing_authorization_release`, `issuing_dispute`, `issuing_transaction`, `payment`, `payment_failure_refund`, `payment_refund`, `payout`, `payout_cancel`, `payout_failure`, `refund`, `refund_failure`, `reserve_transaction`, `reserved_funds`, `stripe_fee`, `stripe_fx_fee`, `tax_fee`, `topup`, `topup_reversal`, `transfer`, `transfer_cancel`, `transfer_failure`, or `transfer_refund`. [Learn more](https://stripe.com/docs/reports/balance-transaction-types) about balance transaction types and what they represent. If you are looking to classify transactions for accounting purposes, you might want to consider `reporting_category` instead.
   */
  type: ("adjustment" | "advance" | "advance_funding" | "anticipation_repayment" | "application_fee" | "application_fee_refund" | "charge" | "connect_collection_transfer" | "contribution" | "issuing_authorization_hold" | "issuing_authorization_release" | "issuing_dispute" | "issuing_transaction" | "payment" | "payment_failure_refund" | "payment_refund" | "payout" | "payout_cancel" | "payout_failure" | "refund" | "refund_failure" | "reserve_transaction" | "reserved_funds" | "stripe_fee" | "stripe_fx_fee" | "tax_fee" | "topup" | "topup_reversal" | "transfer" | "transfer_cancel" | "transfer_failure" | "transfer_refund")
}
export interface Fee {
  /**
   * Amount of the fee, in cents.
   */
  amount: number
  /**
   * ID of the Connect application that earned the fee.
   */
  application?: (string | null)
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * Type of the fee, one of: `application_fee`, `stripe_fee` or `tax`.
   */
  type: string
}
export interface ConnectCollectionTransfer {
  /**
   * Amount transferred, in %s.
   */
  amount: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * ID of the account that funds are being collected for.
   */
  destination: (string | Account)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "connect_collection_transfer"
}
/**
 * A dispute occurs when a customer questions your charge with their card issuer.
 * When this happens, you're given the opportunity to respond to the dispute with
 * evidence that shows that the charge is legitimate. You can find more
 * information about the dispute process in our [Disputes and
 * Fraud](/docs/disputes) documentation.
 * 
 * Related guide: [Disputes and Fraud](https://stripe.com/docs/disputes).
 */
export interface Dispute {
  /**
   * Disputed amount. Usually the amount of the charge, but can differ (usually because of currency fluctuation or because only part of the order is disputed).
   */
  amount: number
  /**
   * List of zero, one, or two balance transactions that show funds withdrawn and reinstated to your Stripe account as a result of this dispute.
   */
  balance_transactions: BalanceTransaction[]
  /**
   * ID of the charge that was disputed.
   */
  charge: (string | Charge)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  evidence: DisputeEvidence
  evidence_details: DisputeEvidenceDetails
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * If true, it is still possible to refund the disputed payment. Once the payment has been fully refunded, no further funds will be withdrawn from your Stripe account as a result of this dispute.
   */
  is_charge_refundable: boolean
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "dispute"
  /**
   * ID of the PaymentIntent that was disputed.
   */
  payment_intent?: (string | PaymentIntent | null)
  /**
   * Reason given by cardholder for dispute. Possible values are `bank_cannot_process`, `check_returned`, `credit_not_processed`, `customer_initiated`, `debit_not_authorized`, `duplicate`, `fraudulent`, `general`, `incorrect_account_details`, `insufficient_funds`, `product_not_received`, `product_unacceptable`, `subscription_canceled`, or `unrecognized`. Read more about [dispute reasons](https://stripe.com/docs/disputes/categories).
   */
  reason: string
  /**
   * Current status of dispute. Possible values are `warning_needs_response`, `warning_under_review`, `warning_closed`, `needs_response`, `under_review`, `charge_refunded`, `won`, or `lost`.
   */
  status: ("charge_refunded" | "lost" | "needs_response" | "under_review" | "warning_closed" | "warning_needs_response" | "warning_under_review" | "won")
}
export interface DisputeEvidence {
  /**
   * Any server or activity logs showing proof that the customer accessed or downloaded the purchased digital product. This information should include IP addresses, corresponding timestamps, and any detailed recorded activity.
   */
  access_activity_log?: (string | null)
  /**
   * The billing address provided by the customer.
   */
  billing_address?: (string | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Your subscription cancellation policy, as shown to the customer.
   */
  cancellation_policy?: (string | File | null)
  /**
   * An explanation of how and when the customer was shown your refund policy prior to purchase.
   */
  cancellation_policy_disclosure?: (string | null)
  /**
   * A justification for why the customer's subscription was not canceled.
   */
  cancellation_rebuttal?: (string | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Any communication with the customer that you feel is relevant to your case. Examples include emails proving that the customer received the product or service, or demonstrating their use of or satisfaction with the product or service.
   */
  customer_communication?: (string | File | null)
  /**
   * The email address of the customer.
   */
  customer_email_address?: (string | null)
  /**
   * The name of the customer.
   */
  customer_name?: (string | null)
  /**
   * The IP address that the customer used when making the purchase.
   */
  customer_purchase_ip?: (string | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) A relevant document or contract showing the customer's signature.
   */
  customer_signature?: (string | File | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Documentation for the prior charge that can uniquely identify the charge, such as a receipt, shipping label, work order, etc. This document should be paired with a similar document from the disputed payment that proves the two payments are separate.
   */
  duplicate_charge_documentation?: (string | File | null)
  /**
   * An explanation of the difference between the disputed charge versus the prior charge that appears to be a duplicate.
   */
  duplicate_charge_explanation?: (string | null)
  /**
   * The Stripe ID for the prior charge which appears to be a duplicate of the disputed charge.
   */
  duplicate_charge_id?: (string | null)
  /**
   * A description of the product or service that was sold.
   */
  product_description?: (string | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Any receipt or message sent to the customer notifying them of the charge.
   */
  receipt?: (string | File | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Your refund policy, as shown to the customer.
   */
  refund_policy?: (string | File | null)
  /**
   * Documentation demonstrating that the customer was shown your refund policy prior to purchase.
   */
  refund_policy_disclosure?: (string | null)
  /**
   * A justification for why the customer is not entitled to a refund.
   */
  refund_refusal_explanation?: (string | null)
  /**
   * The date on which the customer received or began receiving the purchased service, in a clear human-readable format.
   */
  service_date?: (string | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Documentation showing proof that a service was provided to the customer. This could include a copy of a signed contract, work order, or other form of written agreement.
   */
  service_documentation?: (string | File | null)
  /**
   * The address to which a physical product was shipped. You should try to include as complete address information as possible.
   */
  shipping_address?: (string | null)
  /**
   * The delivery service that shipped a physical product, such as Fedex, UPS, USPS, etc. If multiple carriers were used for this purchase, please separate them with commas.
   */
  shipping_carrier?: (string | null)
  /**
   * The date on which a physical product began its route to the shipping address, in a clear human-readable format.
   */
  shipping_date?: (string | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Documentation showing proof that a product was shipped to the customer at the same address the customer provided to you. This could include a copy of the shipment receipt, shipping label, etc. It should show the customer's full shipping address, if possible.
   */
  shipping_documentation?: (string | File | null)
  /**
   * The tracking number for a physical product, obtained from the delivery service. If multiple tracking numbers were generated for this purchase, please separate them with commas.
   */
  shipping_tracking_number?: (string | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Any additional evidence or statements.
   */
  uncategorized_file?: (string | File | null)
  /**
   * Any additional evidence or statements.
   */
  uncategorized_text?: (string | null)
}
export interface DisputeEvidenceDetails {
  /**
   * Date by which evidence must be submitted in order to successfully challenge dispute. Will be null if the customer's bank or credit card company doesn't allow a response for this particular dispute.
   */
  due_by?: (number | null)
  /**
   * Whether evidence has been staged for this dispute.
   */
  has_evidence: boolean
  /**
   * Whether the last evidence submission was submitted past the due date. Defaults to `false` if no evidence submissions have occurred. If `true`, then delivery of the latest evidence is *not* guaranteed.
   */
  past_due: boolean
  /**
   * The number of times evidence has been submitted. Typically, you may only submit evidence once.
   */
  submission_count: number
}
/**
 * `Application Fee Refund` objects allow you to refund an application fee that
 * has previously been created but not yet refunded. Funds will be refunded to
 * the Stripe account from which the fee was originally collected.
 * 
 * Related guide: [Refunding Application Fees](https://stripe.com/docs/connect/destination-charges#refunding-app-fee).
 */
export interface FeeRefund {
  /**
   * Amount, in %s.
   */
  amount: number
  /**
   * Balance transaction that describes the impact on your account balance.
   */
  balance_transaction?: (string | BalanceTransaction | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * ID of the application fee that was refunded.
   */
  fee: (string | PlatformFee)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "fee_refund"
}
/**
 * When an [issued card](https://stripe.com/docs/issuing) is used to make a purchase, an Issuing `Authorization`
 * object is created. [Authorizations](https://stripe.com/docs/issuing/purchases/authorizations) must be approved for the
 * purchase to be completed successfully.
 * 
 * Related guide: [Issued Card Authorizations](https://stripe.com/docs/issuing/purchases/authorizations).
 */
export interface IssuingAuthorization {
  /**
   * The total amount that was authorized or rejected. This amount is in the card's currency and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  amount: number
  /**
   * Detailed breakdown of amount components. These amounts are denominated in `currency` and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  amount_details?: (IssuingAuthorizationAmountDetails | null)
  /**
   * Whether the authorization has been approved.
   */
  approved: boolean
  /**
   * How the card details were provided.
   */
  authorization_method: ("chip" | "contactless" | "keyed_in" | "online" | "swipe")
  /**
   * List of balance transactions associated with this authorization.
   */
  balance_transactions: BalanceTransaction[]
  card: IssuingCard
  /**
   * The cardholder to whom this authorization belongs.
   */
  cardholder?: (string | IssuingCardholder | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * The total amount that was authorized or rejected. This amount is in the `merchant_currency` and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  merchant_amount: number
  /**
   * The currency that was presented to the cardholder for the authorization. Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  merchant_currency: string
  merchant_data: IssuingAuthorizationMerchantData
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * Details about the authorization, such as identifiers, set by the card network.
   */
  network_data?: (IssuingAuthorizationNetworkData | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "issuing.authorization"
  /**
   * The pending authorization request. This field will only be non-null during an `issuing_authorization.request` webhook.
   */
  pending_request?: (IssuingAuthorizationPendingRequest | null)
  /**
   * History of every time a `pending_request` authorization was approved/declined, either by you directly or by Stripe (e.g. based on your spending_controls). If the merchant changes the authorization by performing an incremental authorization, you can look at this field to see the previous requests for the authorization. This field can be helpful in determining why a given authorization was approved/declined.
   */
  request_history: IssuingAuthorizationRequest[]
  /**
   * The current status of the authorization in its lifecycle.
   */
  status: ("closed" | "pending" | "reversed")
  /**
   * List of [transactions](https://stripe.com/docs/api/issuing/transactions) associated with this authorization.
   */
  transactions: IssuingTransaction[]
  /**
   * [Treasury](https://stripe.com/docs/api/treasury) details related to this authorization if it was created on a [FinancialAccount](https://stripe.com/docs/api/treasury/financial_accounts).
   */
  treasury?: (IssuingAuthorizationTreasury | null)
  verification_data: IssuingAuthorizationVerificationData
  /**
   * The digital wallet used for this transaction. One of `apple_pay`, `google_pay`, or `samsung_pay`. Will populate as `null` when no digital wallet was utilized.
   */
  wallet?: (string | null)
}
export interface IssuingAuthorizationAmountDetails {
  /**
   * The fee charged by the ATM for the cash withdrawal.
   */
  atm_fee?: (number | null)
}
/**
 * You can [create physical or virtual cards](https://stripe.com/docs/issuing/cards) that are issued to cardholders.
 */
export interface IssuingCard {
  /**
   * The brand of the card.
   */
  brand: string
  /**
   * The reason why the card was canceled.
   */
  cancellation_reason?: ("design_rejected" | "lost" | "stolen" | null)
  cardholder: IssuingCardholder
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Supported currencies are `usd` in the US, `eur` in the EU, and `gbp` in the UK.
   */
  currency: string
  /**
   * The card's CVC. For security reasons, this is only available for virtual cards, and will be omitted unless you explicitly request it with [the `expand` parameter](https://stripe.com/docs/api/expanding_objects). Additionally, it's only available via the ["Retrieve a card" endpoint](https://stripe.com/docs/api/issuing/cards/retrieve), not via "List all cards" or any other endpoint.
   */
  cvc?: string
  /**
   * The expiration month of the card.
   */
  exp_month: number
  /**
   * The expiration year of the card.
   */
  exp_year: number
  /**
   * The financial account this card is attached to.
   */
  financial_account?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The last 4 digits of the card number.
   */
  last4: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * The full unredacted card number. For security reasons, this is only available for virtual cards, and will be omitted unless you explicitly request it with [the `expand` parameter](https://stripe.com/docs/api/expanding_objects). Additionally, it's only available via the ["Retrieve a card" endpoint](https://stripe.com/docs/api/issuing/cards/retrieve), not via "List all cards" or any other endpoint.
   */
  number?: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "issuing.card"
  /**
   * The latest card that replaces this card, if any.
   */
  replaced_by?: (string | IssuingCard | null)
  /**
   * The card this card replaces, if any.
   */
  replacement_for?: (string | IssuingCard | null)
  /**
   * The reason why the previous card needed to be replaced.
   */
  replacement_reason?: ("damaged" | "expired" | "lost" | "stolen" | null)
  /**
   * Where and how the card will be shipped.
   */
  shipping?: (IssuingCardShipping | null)
  spending_controls: IssuingCardAuthorizationControls
  /**
   * Whether authorizations can be approved on this card. May be blocked from activating cards depending on past-due Cardholder requirements. Defaults to `inactive`.
   */
  status: ("active" | "canceled" | "inactive")
  /**
   * The type of the card.
   */
  type: ("physical" | "virtual")
  /**
   * Information relating to digital wallets (like Apple Pay and Google Pay).
   */
  wallets?: (IssuingCardWallets | null)
}
/**
 * An Issuing `Cardholder` object represents an individual or business entity who is [issued](https://stripe.com/docs/issuing) cards.
 * 
 * Related guide: [How to create a Cardholder](https://stripe.com/docs/issuing/cards#create-cardholder)
 */
export interface IssuingCardholder {
  billing: IssuingCardholderAddress
  /**
   * Additional information about a `company` cardholder.
   */
  company?: (IssuingCardholderCompany | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * The cardholder's email address.
   */
  email?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Additional information about an `individual` cardholder.
   */
  individual?: (IssuingCardholderIndividual | null)
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * The cardholder's name. This will be printed on cards issued to them.
   */
  name: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "issuing.cardholder"
  /**
   * The cardholder's phone number. This is required for all cardholders who will be creating EU cards. See the [3D Secure documentation](https://stripe.com/docs/issuing/3d-secure#when-is-3d-secure-applied) for more details.
   */
  phone_number?: (string | null)
  requirements: IssuingCardholderRequirements
  /**
   * Rules that control spending across this cardholder's cards. Refer to our [documentation](https://stripe.com/docs/issuing/controls/spending-controls) for more details.
   */
  spending_controls?: (IssuingCardholderAuthorizationControls | null)
  /**
   * Specifies whether to permit authorizations on this cardholder's cards.
   */
  status: ("active" | "blocked" | "inactive")
  /**
   * One of `individual` or `company`.
   */
  type: ("company" | "individual")
}
export interface IssuingCardholderAddress {
  address: Address
}
export interface IssuingCardholderCompany {
  /**
   * Whether the company's business ID number was provided.
   */
  tax_id_provided: boolean
}
export interface IssuingCardholderIndividual {
  /**
   * Information related to the card_issuing program for this cardholder.
   */
  card_issuing?: (IssuingCardholderCardIssuing | null)
  /**
   * The date of birth of this cardholder.
   */
  dob?: (IssuingCardholderIndividualDOB | null)
  /**
   * The first name of this cardholder. Required before activating Cards. This field cannot contain any numbers, special characters (except periods, commas, hyphens, spaces and apostrophes) or non-latin letters.
   */
  first_name?: (string | null)
  /**
   * The last name of this cardholder. Required before activating Cards. This field cannot contain any numbers, special characters (except periods, commas, hyphens, spaces and apostrophes) or non-latin letters.
   */
  last_name?: (string | null)
  /**
   * Government-issued ID document for this cardholder.
   */
  verification?: (IssuingCardholderVerification | null)
}
export interface IssuingCardholderCardIssuing {
  /**
   * Information about cardholder acceptance of [Authorized User Terms](https://stripe.com/docs/issuing/cards).
   */
  user_terms_acceptance?: (IssuingCardholderUserTermsAcceptance | null)
}
export interface IssuingCardholderUserTermsAcceptance {
  /**
   * The Unix timestamp marking when the cardholder accepted the Authorized User Terms. Required for Celtic Spend Card users.
   */
  date?: (number | null)
  /**
   * The IP address from which the cardholder accepted the Authorized User Terms. Required for Celtic Spend Card users.
   */
  ip?: (string | null)
  /**
   * The user agent of the browser from which the cardholder accepted the Authorized User Terms.
   */
  user_agent?: (string | null)
}
export interface IssuingCardholderIndividualDOB {
  /**
   * The day of birth, between 1 and 31.
   */
  day?: (number | null)
  /**
   * The month of birth, between 1 and 12.
   */
  month?: (number | null)
  /**
   * The four-digit year of birth.
   */
  year?: (number | null)
}
export interface IssuingCardholderVerification {
  /**
   * An identifying document, either a passport or local ID card.
   */
  document?: (IssuingCardholderIdDocument | null)
}
export interface IssuingCardholderIdDocument {
  /**
   * The back of a document returned by a [file upload](https://stripe.com/docs/api#create_file) with a `purpose` value of `identity_document`.
   */
  back?: (string | File | null)
  /**
   * The front of a document returned by a [file upload](https://stripe.com/docs/api#create_file) with a `purpose` value of `identity_document`.
   */
  front?: (string | File | null)
}
export interface IssuingCardholderRequirements {
  /**
   * If `disabled_reason` is present, all cards will decline authorizations with `cardholder_verification_required` reason.
   */
  disabled_reason?: ("listed" | "rejected.listed" | "under_review" | null)
  /**
   * Array of fields that need to be collected in order to verify and re-enable the cardholder.
   */
  past_due?: (("company.tax_id" | "individual.dob.day" | "individual.dob.month" | "individual.dob.year" | "individual.first_name" | "individual.last_name" | "individual.verification.document")[] | null)
}
export interface IssuingCardholderAuthorizationControls {
  /**
   * Array of strings containing [categories](https://stripe.com/docs/api#issuing_authorization_object-merchant_data-category) of authorizations to allow. All other categories will be blocked. Cannot be set with `blocked_categories`.
   */
  allowed_categories?: (("ac_refrigeration_repair" | "accounting_bookkeeping_services" | "advertising_services" | "agricultural_cooperative" | "airlines_air_carriers" | "airports_flying_fields" | "ambulance_services" | "amusement_parks_carnivals" | "antique_reproductions" | "antique_shops" | "aquariums" | "architectural_surveying_services" | "art_dealers_and_galleries" | "artists_supply_and_craft_shops" | "auto_and_home_supply_stores" | "auto_body_repair_shops" | "auto_paint_shops" | "auto_service_shops" | "automated_cash_disburse" | "automated_fuel_dispensers" | "automobile_associations" | "automotive_parts_and_accessories_stores" | "automotive_tire_stores" | "bail_and_bond_payments" | "bakeries" | "bands_orchestras" | "barber_and_beauty_shops" | "betting_casino_gambling" | "bicycle_shops" | "billiard_pool_establishments" | "boat_dealers" | "boat_rentals_and_leases" | "book_stores" | "books_periodicals_and_newspapers" | "bowling_alleys" | "bus_lines" | "business_secretarial_schools" | "buying_shopping_services" | "cable_satellite_and_other_pay_television_and_radio" | "camera_and_photographic_supply_stores" | "candy_nut_and_confectionery_stores" | "car_and_truck_dealers_new_used" | "car_and_truck_dealers_used_only" | "car_rental_agencies" | "car_washes" | "carpentry_services" | "carpet_upholstery_cleaning" | "caterers" | "charitable_and_social_service_organizations_fundraising" | "chemicals_and_allied_products" | "child_care_services" | "childrens_and_infants_wear_stores" | "chiropodists_podiatrists" | "chiropractors" | "cigar_stores_and_stands" | "civic_social_fraternal_associations" | "cleaning_and_maintenance" | "clothing_rental" | "colleges_universities" | "commercial_equipment" | "commercial_footwear" | "commercial_photography_art_and_graphics" | "commuter_transport_and_ferries" | "computer_network_services" | "computer_programming" | "computer_repair" | "computer_software_stores" | "computers_peripherals_and_software" | "concrete_work_services" | "construction_materials" | "consulting_public_relations" | "correspondence_schools" | "cosmetic_stores" | "counseling_services" | "country_clubs" | "courier_services" | "court_costs" | "credit_reporting_agencies" | "cruise_lines" | "dairy_products_stores" | "dance_hall_studios_schools" | "dating_escort_services" | "dentists_orthodontists" | "department_stores" | "detective_agencies" | "digital_goods_applications" | "digital_goods_games" | "digital_goods_large_volume" | "digital_goods_media" | "direct_marketing_catalog_merchant" | "direct_marketing_combination_catalog_and_retail_merchant" | "direct_marketing_inbound_telemarketing" | "direct_marketing_insurance_services" | "direct_marketing_other" | "direct_marketing_outbound_telemarketing" | "direct_marketing_subscription" | "direct_marketing_travel" | "discount_stores" | "doctors" | "door_to_door_sales" | "drapery_window_covering_and_upholstery_stores" | "drinking_places" | "drug_stores_and_pharmacies" | "drugs_drug_proprietaries_and_druggist_sundries" | "dry_cleaners" | "durable_goods" | "duty_free_stores" | "eating_places_restaurants" | "educational_services" | "electric_razor_stores" | "electrical_parts_and_equipment" | "electrical_services" | "electronics_repair_shops" | "electronics_stores" | "elementary_secondary_schools" | "employment_temp_agencies" | "equipment_rental" | "exterminating_services" | "family_clothing_stores" | "fast_food_restaurants" | "financial_institutions" | "fines_government_administrative_entities" | "fireplace_fireplace_screens_and_accessories_stores" | "floor_covering_stores" | "florists" | "florists_supplies_nursery_stock_and_flowers" | "freezer_and_locker_meat_provisioners" | "fuel_dealers_non_automotive" | "funeral_services_crematories" | "furniture_home_furnishings_and_equipment_stores_except_appliances" | "furniture_repair_refinishing" | "furriers_and_fur_shops" | "general_services" | "gift_card_novelty_and_souvenir_shops" | "glass_paint_and_wallpaper_stores" | "glassware_crystal_stores" | "golf_courses_public" | "government_services" | "grocery_stores_supermarkets" | "hardware_equipment_and_supplies" | "hardware_stores" | "health_and_beauty_spas" | "hearing_aids_sales_and_supplies" | "heating_plumbing_a_c" | "hobby_toy_and_game_shops" | "home_supply_warehouse_stores" | "hospitals" | "hotels_motels_and_resorts" | "household_appliance_stores" | "industrial_supplies" | "information_retrieval_services" | "insurance_default" | "insurance_underwriting_premiums" | "intra_company_purchases" | "jewelry_stores_watches_clocks_and_silverware_stores" | "landscaping_services" | "laundries" | "laundry_cleaning_services" | "legal_services_attorneys" | "luggage_and_leather_goods_stores" | "lumber_building_materials_stores" | "manual_cash_disburse" | "marinas_service_and_supplies" | "masonry_stonework_and_plaster" | "massage_parlors" | "medical_and_dental_labs" | "medical_dental_ophthalmic_and_hospital_equipment_and_supplies" | "medical_services" | "membership_organizations" | "mens_and_boys_clothing_and_accessories_stores" | "mens_womens_clothing_stores" | "metal_service_centers" | "miscellaneous" | "miscellaneous_apparel_and_accessory_shops" | "miscellaneous_auto_dealers" | "miscellaneous_business_services" | "miscellaneous_food_stores" | "miscellaneous_general_merchandise" | "miscellaneous_general_services" | "miscellaneous_home_furnishing_specialty_stores" | "miscellaneous_publishing_and_printing" | "miscellaneous_recreation_services" | "miscellaneous_repair_shops" | "miscellaneous_specialty_retail" | "mobile_home_dealers" | "motion_picture_theaters" | "motor_freight_carriers_and_trucking" | "motor_homes_dealers" | "motor_vehicle_supplies_and_new_parts" | "motorcycle_shops_and_dealers" | "motorcycle_shops_dealers" | "music_stores_musical_instruments_pianos_and_sheet_music" | "news_dealers_and_newsstands" | "non_fi_money_orders" | "non_fi_stored_value_card_purchase_load" | "nondurable_goods" | "nurseries_lawn_and_garden_supply_stores" | "nursing_personal_care" | "office_and_commercial_furniture" | "opticians_eyeglasses" | "optometrists_ophthalmologist" | "orthopedic_goods_prosthetic_devices" | "osteopaths" | "package_stores_beer_wine_and_liquor" | "paints_varnishes_and_supplies" | "parking_lots_garages" | "passenger_railways" | "pawn_shops" | "pet_shops_pet_food_and_supplies" | "petroleum_and_petroleum_products" | "photo_developing" | "photographic_photocopy_microfilm_equipment_and_supplies" | "photographic_studios" | "picture_video_production" | "piece_goods_notions_and_other_dry_goods" | "plumbing_heating_equipment_and_supplies" | "political_organizations" | "postal_services_government_only" | "precious_stones_and_metals_watches_and_jewelry" | "professional_services" | "public_warehousing_and_storage" | "quick_copy_repro_and_blueprint" | "railroads" | "real_estate_agents_and_managers_rentals" | "record_stores" | "recreational_vehicle_rentals" | "religious_goods_stores" | "religious_organizations" | "roofing_siding_sheet_metal" | "secretarial_support_services" | "security_brokers_dealers" | "service_stations" | "sewing_needlework_fabric_and_piece_goods_stores" | "shoe_repair_hat_cleaning" | "shoe_stores" | "small_appliance_repair" | "snowmobile_dealers" | "special_trade_services" | "specialty_cleaning" | "sporting_goods_stores" | "sporting_recreation_camps" | "sports_and_riding_apparel_stores" | "sports_clubs_fields" | "stamp_and_coin_stores" | "stationary_office_supplies_printing_and_writing_paper" | "stationery_stores_office_and_school_supply_stores" | "swimming_pools_sales" | "t_ui_travel_germany" | "tailors_alterations" | "tax_payments_government_agencies" | "tax_preparation_services" | "taxicabs_limousines" | "telecommunication_equipment_and_telephone_sales" | "telecommunication_services" | "telegraph_services" | "tent_and_awning_shops" | "testing_laboratories" | "theatrical_ticket_agencies" | "timeshares" | "tire_retreading_and_repair" | "tolls_bridge_fees" | "tourist_attractions_and_exhibits" | "towing_services" | "trailer_parks_campgrounds" | "transportation_services" | "travel_agencies_tour_operators" | "truck_stop_iteration" | "truck_utility_trailer_rentals" | "typesetting_plate_making_and_related_services" | "typewriter_stores" | "u_s_federal_government_agencies_or_departments" | "uniforms_commercial_clothing" | "used_merchandise_and_secondhand_stores" | "utilities" | "variety_stores" | "veterinary_services" | "video_amusement_game_supplies" | "video_game_arcades" | "video_tape_rental_stores" | "vocational_trade_schools" | "watch_jewelry_repair" | "welding_repair" | "wholesale_clubs" | "wig_and_toupee_stores" | "wires_money_orders" | "womens_accessory_and_specialty_shops" | "womens_ready_to_wear_stores" | "wrecking_and_salvage_yards")[] | null)
  /**
   * Array of strings containing [categories](https://stripe.com/docs/api#issuing_authorization_object-merchant_data-category) of authorizations to decline. All other categories will be allowed. Cannot be set with `allowed_categories`.
   */
  blocked_categories?: (("ac_refrigeration_repair" | "accounting_bookkeeping_services" | "advertising_services" | "agricultural_cooperative" | "airlines_air_carriers" | "airports_flying_fields" | "ambulance_services" | "amusement_parks_carnivals" | "antique_reproductions" | "antique_shops" | "aquariums" | "architectural_surveying_services" | "art_dealers_and_galleries" | "artists_supply_and_craft_shops" | "auto_and_home_supply_stores" | "auto_body_repair_shops" | "auto_paint_shops" | "auto_service_shops" | "automated_cash_disburse" | "automated_fuel_dispensers" | "automobile_associations" | "automotive_parts_and_accessories_stores" | "automotive_tire_stores" | "bail_and_bond_payments" | "bakeries" | "bands_orchestras" | "barber_and_beauty_shops" | "betting_casino_gambling" | "bicycle_shops" | "billiard_pool_establishments" | "boat_dealers" | "boat_rentals_and_leases" | "book_stores" | "books_periodicals_and_newspapers" | "bowling_alleys" | "bus_lines" | "business_secretarial_schools" | "buying_shopping_services" | "cable_satellite_and_other_pay_television_and_radio" | "camera_and_photographic_supply_stores" | "candy_nut_and_confectionery_stores" | "car_and_truck_dealers_new_used" | "car_and_truck_dealers_used_only" | "car_rental_agencies" | "car_washes" | "carpentry_services" | "carpet_upholstery_cleaning" | "caterers" | "charitable_and_social_service_organizations_fundraising" | "chemicals_and_allied_products" | "child_care_services" | "childrens_and_infants_wear_stores" | "chiropodists_podiatrists" | "chiropractors" | "cigar_stores_and_stands" | "civic_social_fraternal_associations" | "cleaning_and_maintenance" | "clothing_rental" | "colleges_universities" | "commercial_equipment" | "commercial_footwear" | "commercial_photography_art_and_graphics" | "commuter_transport_and_ferries" | "computer_network_services" | "computer_programming" | "computer_repair" | "computer_software_stores" | "computers_peripherals_and_software" | "concrete_work_services" | "construction_materials" | "consulting_public_relations" | "correspondence_schools" | "cosmetic_stores" | "counseling_services" | "country_clubs" | "courier_services" | "court_costs" | "credit_reporting_agencies" | "cruise_lines" | "dairy_products_stores" | "dance_hall_studios_schools" | "dating_escort_services" | "dentists_orthodontists" | "department_stores" | "detective_agencies" | "digital_goods_applications" | "digital_goods_games" | "digital_goods_large_volume" | "digital_goods_media" | "direct_marketing_catalog_merchant" | "direct_marketing_combination_catalog_and_retail_merchant" | "direct_marketing_inbound_telemarketing" | "direct_marketing_insurance_services" | "direct_marketing_other" | "direct_marketing_outbound_telemarketing" | "direct_marketing_subscription" | "direct_marketing_travel" | "discount_stores" | "doctors" | "door_to_door_sales" | "drapery_window_covering_and_upholstery_stores" | "drinking_places" | "drug_stores_and_pharmacies" | "drugs_drug_proprietaries_and_druggist_sundries" | "dry_cleaners" | "durable_goods" | "duty_free_stores" | "eating_places_restaurants" | "educational_services" | "electric_razor_stores" | "electrical_parts_and_equipment" | "electrical_services" | "electronics_repair_shops" | "electronics_stores" | "elementary_secondary_schools" | "employment_temp_agencies" | "equipment_rental" | "exterminating_services" | "family_clothing_stores" | "fast_food_restaurants" | "financial_institutions" | "fines_government_administrative_entities" | "fireplace_fireplace_screens_and_accessories_stores" | "floor_covering_stores" | "florists" | "florists_supplies_nursery_stock_and_flowers" | "freezer_and_locker_meat_provisioners" | "fuel_dealers_non_automotive" | "funeral_services_crematories" | "furniture_home_furnishings_and_equipment_stores_except_appliances" | "furniture_repair_refinishing" | "furriers_and_fur_shops" | "general_services" | "gift_card_novelty_and_souvenir_shops" | "glass_paint_and_wallpaper_stores" | "glassware_crystal_stores" | "golf_courses_public" | "government_services" | "grocery_stores_supermarkets" | "hardware_equipment_and_supplies" | "hardware_stores" | "health_and_beauty_spas" | "hearing_aids_sales_and_supplies" | "heating_plumbing_a_c" | "hobby_toy_and_game_shops" | "home_supply_warehouse_stores" | "hospitals" | "hotels_motels_and_resorts" | "household_appliance_stores" | "industrial_supplies" | "information_retrieval_services" | "insurance_default" | "insurance_underwriting_premiums" | "intra_company_purchases" | "jewelry_stores_watches_clocks_and_silverware_stores" | "landscaping_services" | "laundries" | "laundry_cleaning_services" | "legal_services_attorneys" | "luggage_and_leather_goods_stores" | "lumber_building_materials_stores" | "manual_cash_disburse" | "marinas_service_and_supplies" | "masonry_stonework_and_plaster" | "massage_parlors" | "medical_and_dental_labs" | "medical_dental_ophthalmic_and_hospital_equipment_and_supplies" | "medical_services" | "membership_organizations" | "mens_and_boys_clothing_and_accessories_stores" | "mens_womens_clothing_stores" | "metal_service_centers" | "miscellaneous" | "miscellaneous_apparel_and_accessory_shops" | "miscellaneous_auto_dealers" | "miscellaneous_business_services" | "miscellaneous_food_stores" | "miscellaneous_general_merchandise" | "miscellaneous_general_services" | "miscellaneous_home_furnishing_specialty_stores" | "miscellaneous_publishing_and_printing" | "miscellaneous_recreation_services" | "miscellaneous_repair_shops" | "miscellaneous_specialty_retail" | "mobile_home_dealers" | "motion_picture_theaters" | "motor_freight_carriers_and_trucking" | "motor_homes_dealers" | "motor_vehicle_supplies_and_new_parts" | "motorcycle_shops_and_dealers" | "motorcycle_shops_dealers" | "music_stores_musical_instruments_pianos_and_sheet_music" | "news_dealers_and_newsstands" | "non_fi_money_orders" | "non_fi_stored_value_card_purchase_load" | "nondurable_goods" | "nurseries_lawn_and_garden_supply_stores" | "nursing_personal_care" | "office_and_commercial_furniture" | "opticians_eyeglasses" | "optometrists_ophthalmologist" | "orthopedic_goods_prosthetic_devices" | "osteopaths" | "package_stores_beer_wine_and_liquor" | "paints_varnishes_and_supplies" | "parking_lots_garages" | "passenger_railways" | "pawn_shops" | "pet_shops_pet_food_and_supplies" | "petroleum_and_petroleum_products" | "photo_developing" | "photographic_photocopy_microfilm_equipment_and_supplies" | "photographic_studios" | "picture_video_production" | "piece_goods_notions_and_other_dry_goods" | "plumbing_heating_equipment_and_supplies" | "political_organizations" | "postal_services_government_only" | "precious_stones_and_metals_watches_and_jewelry" | "professional_services" | "public_warehousing_and_storage" | "quick_copy_repro_and_blueprint" | "railroads" | "real_estate_agents_and_managers_rentals" | "record_stores" | "recreational_vehicle_rentals" | "religious_goods_stores" | "religious_organizations" | "roofing_siding_sheet_metal" | "secretarial_support_services" | "security_brokers_dealers" | "service_stations" | "sewing_needlework_fabric_and_piece_goods_stores" | "shoe_repair_hat_cleaning" | "shoe_stores" | "small_appliance_repair" | "snowmobile_dealers" | "special_trade_services" | "specialty_cleaning" | "sporting_goods_stores" | "sporting_recreation_camps" | "sports_and_riding_apparel_stores" | "sports_clubs_fields" | "stamp_and_coin_stores" | "stationary_office_supplies_printing_and_writing_paper" | "stationery_stores_office_and_school_supply_stores" | "swimming_pools_sales" | "t_ui_travel_germany" | "tailors_alterations" | "tax_payments_government_agencies" | "tax_preparation_services" | "taxicabs_limousines" | "telecommunication_equipment_and_telephone_sales" | "telecommunication_services" | "telegraph_services" | "tent_and_awning_shops" | "testing_laboratories" | "theatrical_ticket_agencies" | "timeshares" | "tire_retreading_and_repair" | "tolls_bridge_fees" | "tourist_attractions_and_exhibits" | "towing_services" | "trailer_parks_campgrounds" | "transportation_services" | "travel_agencies_tour_operators" | "truck_stop_iteration" | "truck_utility_trailer_rentals" | "typesetting_plate_making_and_related_services" | "typewriter_stores" | "u_s_federal_government_agencies_or_departments" | "uniforms_commercial_clothing" | "used_merchandise_and_secondhand_stores" | "utilities" | "variety_stores" | "veterinary_services" | "video_amusement_game_supplies" | "video_game_arcades" | "video_tape_rental_stores" | "vocational_trade_schools" | "watch_jewelry_repair" | "welding_repair" | "wholesale_clubs" | "wig_and_toupee_stores" | "wires_money_orders" | "womens_accessory_and_specialty_shops" | "womens_ready_to_wear_stores" | "wrecking_and_salvage_yards")[] | null)
  /**
   * Limit spending with amount-based rules that apply across this cardholder's cards.
   */
  spending_limits?: (IssuingCardholderSpendingLimit[] | null)
  /**
   * Currency of the amounts within `spending_limits`.
   */
  spending_limits_currency?: (string | null)
}
export interface IssuingCardholderSpendingLimit {
  /**
   * Maximum amount allowed to spend per interval. This amount is in the card's currency and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  amount: number
  /**
   * Array of strings containing [categories](https://stripe.com/docs/api#issuing_authorization_object-merchant_data-category) this limit applies to. Omitting this field will apply the limit to all categories.
   */
  categories?: (("ac_refrigeration_repair" | "accounting_bookkeeping_services" | "advertising_services" | "agricultural_cooperative" | "airlines_air_carriers" | "airports_flying_fields" | "ambulance_services" | "amusement_parks_carnivals" | "antique_reproductions" | "antique_shops" | "aquariums" | "architectural_surveying_services" | "art_dealers_and_galleries" | "artists_supply_and_craft_shops" | "auto_and_home_supply_stores" | "auto_body_repair_shops" | "auto_paint_shops" | "auto_service_shops" | "automated_cash_disburse" | "automated_fuel_dispensers" | "automobile_associations" | "automotive_parts_and_accessories_stores" | "automotive_tire_stores" | "bail_and_bond_payments" | "bakeries" | "bands_orchestras" | "barber_and_beauty_shops" | "betting_casino_gambling" | "bicycle_shops" | "billiard_pool_establishments" | "boat_dealers" | "boat_rentals_and_leases" | "book_stores" | "books_periodicals_and_newspapers" | "bowling_alleys" | "bus_lines" | "business_secretarial_schools" | "buying_shopping_services" | "cable_satellite_and_other_pay_television_and_radio" | "camera_and_photographic_supply_stores" | "candy_nut_and_confectionery_stores" | "car_and_truck_dealers_new_used" | "car_and_truck_dealers_used_only" | "car_rental_agencies" | "car_washes" | "carpentry_services" | "carpet_upholstery_cleaning" | "caterers" | "charitable_and_social_service_organizations_fundraising" | "chemicals_and_allied_products" | "child_care_services" | "childrens_and_infants_wear_stores" | "chiropodists_podiatrists" | "chiropractors" | "cigar_stores_and_stands" | "civic_social_fraternal_associations" | "cleaning_and_maintenance" | "clothing_rental" | "colleges_universities" | "commercial_equipment" | "commercial_footwear" | "commercial_photography_art_and_graphics" | "commuter_transport_and_ferries" | "computer_network_services" | "computer_programming" | "computer_repair" | "computer_software_stores" | "computers_peripherals_and_software" | "concrete_work_services" | "construction_materials" | "consulting_public_relations" | "correspondence_schools" | "cosmetic_stores" | "counseling_services" | "country_clubs" | "courier_services" | "court_costs" | "credit_reporting_agencies" | "cruise_lines" | "dairy_products_stores" | "dance_hall_studios_schools" | "dating_escort_services" | "dentists_orthodontists" | "department_stores" | "detective_agencies" | "digital_goods_applications" | "digital_goods_games" | "digital_goods_large_volume" | "digital_goods_media" | "direct_marketing_catalog_merchant" | "direct_marketing_combination_catalog_and_retail_merchant" | "direct_marketing_inbound_telemarketing" | "direct_marketing_insurance_services" | "direct_marketing_other" | "direct_marketing_outbound_telemarketing" | "direct_marketing_subscription" | "direct_marketing_travel" | "discount_stores" | "doctors" | "door_to_door_sales" | "drapery_window_covering_and_upholstery_stores" | "drinking_places" | "drug_stores_and_pharmacies" | "drugs_drug_proprietaries_and_druggist_sundries" | "dry_cleaners" | "durable_goods" | "duty_free_stores" | "eating_places_restaurants" | "educational_services" | "electric_razor_stores" | "electrical_parts_and_equipment" | "electrical_services" | "electronics_repair_shops" | "electronics_stores" | "elementary_secondary_schools" | "employment_temp_agencies" | "equipment_rental" | "exterminating_services" | "family_clothing_stores" | "fast_food_restaurants" | "financial_institutions" | "fines_government_administrative_entities" | "fireplace_fireplace_screens_and_accessories_stores" | "floor_covering_stores" | "florists" | "florists_supplies_nursery_stock_and_flowers" | "freezer_and_locker_meat_provisioners" | "fuel_dealers_non_automotive" | "funeral_services_crematories" | "furniture_home_furnishings_and_equipment_stores_except_appliances" | "furniture_repair_refinishing" | "furriers_and_fur_shops" | "general_services" | "gift_card_novelty_and_souvenir_shops" | "glass_paint_and_wallpaper_stores" | "glassware_crystal_stores" | "golf_courses_public" | "government_services" | "grocery_stores_supermarkets" | "hardware_equipment_and_supplies" | "hardware_stores" | "health_and_beauty_spas" | "hearing_aids_sales_and_supplies" | "heating_plumbing_a_c" | "hobby_toy_and_game_shops" | "home_supply_warehouse_stores" | "hospitals" | "hotels_motels_and_resorts" | "household_appliance_stores" | "industrial_supplies" | "information_retrieval_services" | "insurance_default" | "insurance_underwriting_premiums" | "intra_company_purchases" | "jewelry_stores_watches_clocks_and_silverware_stores" | "landscaping_services" | "laundries" | "laundry_cleaning_services" | "legal_services_attorneys" | "luggage_and_leather_goods_stores" | "lumber_building_materials_stores" | "manual_cash_disburse" | "marinas_service_and_supplies" | "masonry_stonework_and_plaster" | "massage_parlors" | "medical_and_dental_labs" | "medical_dental_ophthalmic_and_hospital_equipment_and_supplies" | "medical_services" | "membership_organizations" | "mens_and_boys_clothing_and_accessories_stores" | "mens_womens_clothing_stores" | "metal_service_centers" | "miscellaneous" | "miscellaneous_apparel_and_accessory_shops" | "miscellaneous_auto_dealers" | "miscellaneous_business_services" | "miscellaneous_food_stores" | "miscellaneous_general_merchandise" | "miscellaneous_general_services" | "miscellaneous_home_furnishing_specialty_stores" | "miscellaneous_publishing_and_printing" | "miscellaneous_recreation_services" | "miscellaneous_repair_shops" | "miscellaneous_specialty_retail" | "mobile_home_dealers" | "motion_picture_theaters" | "motor_freight_carriers_and_trucking" | "motor_homes_dealers" | "motor_vehicle_supplies_and_new_parts" | "motorcycle_shops_and_dealers" | "motorcycle_shops_dealers" | "music_stores_musical_instruments_pianos_and_sheet_music" | "news_dealers_and_newsstands" | "non_fi_money_orders" | "non_fi_stored_value_card_purchase_load" | "nondurable_goods" | "nurseries_lawn_and_garden_supply_stores" | "nursing_personal_care" | "office_and_commercial_furniture" | "opticians_eyeglasses" | "optometrists_ophthalmologist" | "orthopedic_goods_prosthetic_devices" | "osteopaths" | "package_stores_beer_wine_and_liquor" | "paints_varnishes_and_supplies" | "parking_lots_garages" | "passenger_railways" | "pawn_shops" | "pet_shops_pet_food_and_supplies" | "petroleum_and_petroleum_products" | "photo_developing" | "photographic_photocopy_microfilm_equipment_and_supplies" | "photographic_studios" | "picture_video_production" | "piece_goods_notions_and_other_dry_goods" | "plumbing_heating_equipment_and_supplies" | "political_organizations" | "postal_services_government_only" | "precious_stones_and_metals_watches_and_jewelry" | "professional_services" | "public_warehousing_and_storage" | "quick_copy_repro_and_blueprint" | "railroads" | "real_estate_agents_and_managers_rentals" | "record_stores" | "recreational_vehicle_rentals" | "religious_goods_stores" | "religious_organizations" | "roofing_siding_sheet_metal" | "secretarial_support_services" | "security_brokers_dealers" | "service_stations" | "sewing_needlework_fabric_and_piece_goods_stores" | "shoe_repair_hat_cleaning" | "shoe_stores" | "small_appliance_repair" | "snowmobile_dealers" | "special_trade_services" | "specialty_cleaning" | "sporting_goods_stores" | "sporting_recreation_camps" | "sports_and_riding_apparel_stores" | "sports_clubs_fields" | "stamp_and_coin_stores" | "stationary_office_supplies_printing_and_writing_paper" | "stationery_stores_office_and_school_supply_stores" | "swimming_pools_sales" | "t_ui_travel_germany" | "tailors_alterations" | "tax_payments_government_agencies" | "tax_preparation_services" | "taxicabs_limousines" | "telecommunication_equipment_and_telephone_sales" | "telecommunication_services" | "telegraph_services" | "tent_and_awning_shops" | "testing_laboratories" | "theatrical_ticket_agencies" | "timeshares" | "tire_retreading_and_repair" | "tolls_bridge_fees" | "tourist_attractions_and_exhibits" | "towing_services" | "trailer_parks_campgrounds" | "transportation_services" | "travel_agencies_tour_operators" | "truck_stop_iteration" | "truck_utility_trailer_rentals" | "typesetting_plate_making_and_related_services" | "typewriter_stores" | "u_s_federal_government_agencies_or_departments" | "uniforms_commercial_clothing" | "used_merchandise_and_secondhand_stores" | "utilities" | "variety_stores" | "veterinary_services" | "video_amusement_game_supplies" | "video_game_arcades" | "video_tape_rental_stores" | "vocational_trade_schools" | "watch_jewelry_repair" | "welding_repair" | "wholesale_clubs" | "wig_and_toupee_stores" | "wires_money_orders" | "womens_accessory_and_specialty_shops" | "womens_ready_to_wear_stores" | "wrecking_and_salvage_yards")[] | null)
  /**
   * Interval (or event) to which the amount applies.
   */
  interval: ("all_time" | "daily" | "monthly" | "per_authorization" | "weekly" | "yearly")
}
export interface IssuingCardShipping {
  address: Address
  /**
   * The delivery company that shipped a card.
   */
  carrier?: ("dhl" | "fedex" | "royal_mail" | "usps" | null)
  /**
   * Additional information that may be required for clearing customs.
   */
  customs?: (IssuingCardShippingCustoms | null)
  /**
   * A unix timestamp representing a best estimate of when the card will be delivered.
   */
  eta?: (number | null)
  /**
   * Recipient name.
   */
  name: string
  /**
   * The phone number of the receiver of the bulk shipment. This phone number will be provided to the shipping company, who might use it to contact the receiver in case of delivery issues.
   */
  phone_number?: (string | null)
  /**
   * Whether a signature is required for card delivery. This feature is only supported for US users. Standard shipping service does not support signature on delivery. The default value for standard shipping service is false and for express and priority services is true.
   */
  require_signature?: (boolean | null)
  /**
   * Shipment service, such as `standard` or `express`.
   */
  service: ("express" | "priority" | "standard")
  /**
   * The delivery status of the card.
   */
  status?: ("canceled" | "delivered" | "failure" | "pending" | "returned" | "shipped" | null)
  /**
   * A tracking number for a card shipment.
   */
  tracking_number?: (string | null)
  /**
   * A link to the shipping carrier's site where you can view detailed information about a card shipment.
   */
  tracking_url?: (string | null)
  /**
   * Packaging options.
   */
  type: ("bulk" | "individual")
}
export interface IssuingCardShippingCustoms {
  /**
   * A registration number used for customs in Europe. See https://www.gov.uk/eori and https://ec.europa.eu/taxation_customs/business/customs-procedures-import-and-export/customs-procedures/economic-operators-registration-and-identification-number-eori_en.
   */
  eori_number?: (string | null)
}
export interface IssuingCardAuthorizationControls {
  /**
   * Array of strings containing [categories](https://stripe.com/docs/api#issuing_authorization_object-merchant_data-category) of authorizations to allow. All other categories will be blocked. Cannot be set with `blocked_categories`.
   */
  allowed_categories?: (("ac_refrigeration_repair" | "accounting_bookkeeping_services" | "advertising_services" | "agricultural_cooperative" | "airlines_air_carriers" | "airports_flying_fields" | "ambulance_services" | "amusement_parks_carnivals" | "antique_reproductions" | "antique_shops" | "aquariums" | "architectural_surveying_services" | "art_dealers_and_galleries" | "artists_supply_and_craft_shops" | "auto_and_home_supply_stores" | "auto_body_repair_shops" | "auto_paint_shops" | "auto_service_shops" | "automated_cash_disburse" | "automated_fuel_dispensers" | "automobile_associations" | "automotive_parts_and_accessories_stores" | "automotive_tire_stores" | "bail_and_bond_payments" | "bakeries" | "bands_orchestras" | "barber_and_beauty_shops" | "betting_casino_gambling" | "bicycle_shops" | "billiard_pool_establishments" | "boat_dealers" | "boat_rentals_and_leases" | "book_stores" | "books_periodicals_and_newspapers" | "bowling_alleys" | "bus_lines" | "business_secretarial_schools" | "buying_shopping_services" | "cable_satellite_and_other_pay_television_and_radio" | "camera_and_photographic_supply_stores" | "candy_nut_and_confectionery_stores" | "car_and_truck_dealers_new_used" | "car_and_truck_dealers_used_only" | "car_rental_agencies" | "car_washes" | "carpentry_services" | "carpet_upholstery_cleaning" | "caterers" | "charitable_and_social_service_organizations_fundraising" | "chemicals_and_allied_products" | "child_care_services" | "childrens_and_infants_wear_stores" | "chiropodists_podiatrists" | "chiropractors" | "cigar_stores_and_stands" | "civic_social_fraternal_associations" | "cleaning_and_maintenance" | "clothing_rental" | "colleges_universities" | "commercial_equipment" | "commercial_footwear" | "commercial_photography_art_and_graphics" | "commuter_transport_and_ferries" | "computer_network_services" | "computer_programming" | "computer_repair" | "computer_software_stores" | "computers_peripherals_and_software" | "concrete_work_services" | "construction_materials" | "consulting_public_relations" | "correspondence_schools" | "cosmetic_stores" | "counseling_services" | "country_clubs" | "courier_services" | "court_costs" | "credit_reporting_agencies" | "cruise_lines" | "dairy_products_stores" | "dance_hall_studios_schools" | "dating_escort_services" | "dentists_orthodontists" | "department_stores" | "detective_agencies" | "digital_goods_applications" | "digital_goods_games" | "digital_goods_large_volume" | "digital_goods_media" | "direct_marketing_catalog_merchant" | "direct_marketing_combination_catalog_and_retail_merchant" | "direct_marketing_inbound_telemarketing" | "direct_marketing_insurance_services" | "direct_marketing_other" | "direct_marketing_outbound_telemarketing" | "direct_marketing_subscription" | "direct_marketing_travel" | "discount_stores" | "doctors" | "door_to_door_sales" | "drapery_window_covering_and_upholstery_stores" | "drinking_places" | "drug_stores_and_pharmacies" | "drugs_drug_proprietaries_and_druggist_sundries" | "dry_cleaners" | "durable_goods" | "duty_free_stores" | "eating_places_restaurants" | "educational_services" | "electric_razor_stores" | "electrical_parts_and_equipment" | "electrical_services" | "electronics_repair_shops" | "electronics_stores" | "elementary_secondary_schools" | "employment_temp_agencies" | "equipment_rental" | "exterminating_services" | "family_clothing_stores" | "fast_food_restaurants" | "financial_institutions" | "fines_government_administrative_entities" | "fireplace_fireplace_screens_and_accessories_stores" | "floor_covering_stores" | "florists" | "florists_supplies_nursery_stock_and_flowers" | "freezer_and_locker_meat_provisioners" | "fuel_dealers_non_automotive" | "funeral_services_crematories" | "furniture_home_furnishings_and_equipment_stores_except_appliances" | "furniture_repair_refinishing" | "furriers_and_fur_shops" | "general_services" | "gift_card_novelty_and_souvenir_shops" | "glass_paint_and_wallpaper_stores" | "glassware_crystal_stores" | "golf_courses_public" | "government_services" | "grocery_stores_supermarkets" | "hardware_equipment_and_supplies" | "hardware_stores" | "health_and_beauty_spas" | "hearing_aids_sales_and_supplies" | "heating_plumbing_a_c" | "hobby_toy_and_game_shops" | "home_supply_warehouse_stores" | "hospitals" | "hotels_motels_and_resorts" | "household_appliance_stores" | "industrial_supplies" | "information_retrieval_services" | "insurance_default" | "insurance_underwriting_premiums" | "intra_company_purchases" | "jewelry_stores_watches_clocks_and_silverware_stores" | "landscaping_services" | "laundries" | "laundry_cleaning_services" | "legal_services_attorneys" | "luggage_and_leather_goods_stores" | "lumber_building_materials_stores" | "manual_cash_disburse" | "marinas_service_and_supplies" | "masonry_stonework_and_plaster" | "massage_parlors" | "medical_and_dental_labs" | "medical_dental_ophthalmic_and_hospital_equipment_and_supplies" | "medical_services" | "membership_organizations" | "mens_and_boys_clothing_and_accessories_stores" | "mens_womens_clothing_stores" | "metal_service_centers" | "miscellaneous" | "miscellaneous_apparel_and_accessory_shops" | "miscellaneous_auto_dealers" | "miscellaneous_business_services" | "miscellaneous_food_stores" | "miscellaneous_general_merchandise" | "miscellaneous_general_services" | "miscellaneous_home_furnishing_specialty_stores" | "miscellaneous_publishing_and_printing" | "miscellaneous_recreation_services" | "miscellaneous_repair_shops" | "miscellaneous_specialty_retail" | "mobile_home_dealers" | "motion_picture_theaters" | "motor_freight_carriers_and_trucking" | "motor_homes_dealers" | "motor_vehicle_supplies_and_new_parts" | "motorcycle_shops_and_dealers" | "motorcycle_shops_dealers" | "music_stores_musical_instruments_pianos_and_sheet_music" | "news_dealers_and_newsstands" | "non_fi_money_orders" | "non_fi_stored_value_card_purchase_load" | "nondurable_goods" | "nurseries_lawn_and_garden_supply_stores" | "nursing_personal_care" | "office_and_commercial_furniture" | "opticians_eyeglasses" | "optometrists_ophthalmologist" | "orthopedic_goods_prosthetic_devices" | "osteopaths" | "package_stores_beer_wine_and_liquor" | "paints_varnishes_and_supplies" | "parking_lots_garages" | "passenger_railways" | "pawn_shops" | "pet_shops_pet_food_and_supplies" | "petroleum_and_petroleum_products" | "photo_developing" | "photographic_photocopy_microfilm_equipment_and_supplies" | "photographic_studios" | "picture_video_production" | "piece_goods_notions_and_other_dry_goods" | "plumbing_heating_equipment_and_supplies" | "political_organizations" | "postal_services_government_only" | "precious_stones_and_metals_watches_and_jewelry" | "professional_services" | "public_warehousing_and_storage" | "quick_copy_repro_and_blueprint" | "railroads" | "real_estate_agents_and_managers_rentals" | "record_stores" | "recreational_vehicle_rentals" | "religious_goods_stores" | "religious_organizations" | "roofing_siding_sheet_metal" | "secretarial_support_services" | "security_brokers_dealers" | "service_stations" | "sewing_needlework_fabric_and_piece_goods_stores" | "shoe_repair_hat_cleaning" | "shoe_stores" | "small_appliance_repair" | "snowmobile_dealers" | "special_trade_services" | "specialty_cleaning" | "sporting_goods_stores" | "sporting_recreation_camps" | "sports_and_riding_apparel_stores" | "sports_clubs_fields" | "stamp_and_coin_stores" | "stationary_office_supplies_printing_and_writing_paper" | "stationery_stores_office_and_school_supply_stores" | "swimming_pools_sales" | "t_ui_travel_germany" | "tailors_alterations" | "tax_payments_government_agencies" | "tax_preparation_services" | "taxicabs_limousines" | "telecommunication_equipment_and_telephone_sales" | "telecommunication_services" | "telegraph_services" | "tent_and_awning_shops" | "testing_laboratories" | "theatrical_ticket_agencies" | "timeshares" | "tire_retreading_and_repair" | "tolls_bridge_fees" | "tourist_attractions_and_exhibits" | "towing_services" | "trailer_parks_campgrounds" | "transportation_services" | "travel_agencies_tour_operators" | "truck_stop_iteration" | "truck_utility_trailer_rentals" | "typesetting_plate_making_and_related_services" | "typewriter_stores" | "u_s_federal_government_agencies_or_departments" | "uniforms_commercial_clothing" | "used_merchandise_and_secondhand_stores" | "utilities" | "variety_stores" | "veterinary_services" | "video_amusement_game_supplies" | "video_game_arcades" | "video_tape_rental_stores" | "vocational_trade_schools" | "watch_jewelry_repair" | "welding_repair" | "wholesale_clubs" | "wig_and_toupee_stores" | "wires_money_orders" | "womens_accessory_and_specialty_shops" | "womens_ready_to_wear_stores" | "wrecking_and_salvage_yards")[] | null)
  /**
   * Array of strings containing [categories](https://stripe.com/docs/api#issuing_authorization_object-merchant_data-category) of authorizations to decline. All other categories will be allowed. Cannot be set with `allowed_categories`.
   */
  blocked_categories?: (("ac_refrigeration_repair" | "accounting_bookkeeping_services" | "advertising_services" | "agricultural_cooperative" | "airlines_air_carriers" | "airports_flying_fields" | "ambulance_services" | "amusement_parks_carnivals" | "antique_reproductions" | "antique_shops" | "aquariums" | "architectural_surveying_services" | "art_dealers_and_galleries" | "artists_supply_and_craft_shops" | "auto_and_home_supply_stores" | "auto_body_repair_shops" | "auto_paint_shops" | "auto_service_shops" | "automated_cash_disburse" | "automated_fuel_dispensers" | "automobile_associations" | "automotive_parts_and_accessories_stores" | "automotive_tire_stores" | "bail_and_bond_payments" | "bakeries" | "bands_orchestras" | "barber_and_beauty_shops" | "betting_casino_gambling" | "bicycle_shops" | "billiard_pool_establishments" | "boat_dealers" | "boat_rentals_and_leases" | "book_stores" | "books_periodicals_and_newspapers" | "bowling_alleys" | "bus_lines" | "business_secretarial_schools" | "buying_shopping_services" | "cable_satellite_and_other_pay_television_and_radio" | "camera_and_photographic_supply_stores" | "candy_nut_and_confectionery_stores" | "car_and_truck_dealers_new_used" | "car_and_truck_dealers_used_only" | "car_rental_agencies" | "car_washes" | "carpentry_services" | "carpet_upholstery_cleaning" | "caterers" | "charitable_and_social_service_organizations_fundraising" | "chemicals_and_allied_products" | "child_care_services" | "childrens_and_infants_wear_stores" | "chiropodists_podiatrists" | "chiropractors" | "cigar_stores_and_stands" | "civic_social_fraternal_associations" | "cleaning_and_maintenance" | "clothing_rental" | "colleges_universities" | "commercial_equipment" | "commercial_footwear" | "commercial_photography_art_and_graphics" | "commuter_transport_and_ferries" | "computer_network_services" | "computer_programming" | "computer_repair" | "computer_software_stores" | "computers_peripherals_and_software" | "concrete_work_services" | "construction_materials" | "consulting_public_relations" | "correspondence_schools" | "cosmetic_stores" | "counseling_services" | "country_clubs" | "courier_services" | "court_costs" | "credit_reporting_agencies" | "cruise_lines" | "dairy_products_stores" | "dance_hall_studios_schools" | "dating_escort_services" | "dentists_orthodontists" | "department_stores" | "detective_agencies" | "digital_goods_applications" | "digital_goods_games" | "digital_goods_large_volume" | "digital_goods_media" | "direct_marketing_catalog_merchant" | "direct_marketing_combination_catalog_and_retail_merchant" | "direct_marketing_inbound_telemarketing" | "direct_marketing_insurance_services" | "direct_marketing_other" | "direct_marketing_outbound_telemarketing" | "direct_marketing_subscription" | "direct_marketing_travel" | "discount_stores" | "doctors" | "door_to_door_sales" | "drapery_window_covering_and_upholstery_stores" | "drinking_places" | "drug_stores_and_pharmacies" | "drugs_drug_proprietaries_and_druggist_sundries" | "dry_cleaners" | "durable_goods" | "duty_free_stores" | "eating_places_restaurants" | "educational_services" | "electric_razor_stores" | "electrical_parts_and_equipment" | "electrical_services" | "electronics_repair_shops" | "electronics_stores" | "elementary_secondary_schools" | "employment_temp_agencies" | "equipment_rental" | "exterminating_services" | "family_clothing_stores" | "fast_food_restaurants" | "financial_institutions" | "fines_government_administrative_entities" | "fireplace_fireplace_screens_and_accessories_stores" | "floor_covering_stores" | "florists" | "florists_supplies_nursery_stock_and_flowers" | "freezer_and_locker_meat_provisioners" | "fuel_dealers_non_automotive" | "funeral_services_crematories" | "furniture_home_furnishings_and_equipment_stores_except_appliances" | "furniture_repair_refinishing" | "furriers_and_fur_shops" | "general_services" | "gift_card_novelty_and_souvenir_shops" | "glass_paint_and_wallpaper_stores" | "glassware_crystal_stores" | "golf_courses_public" | "government_services" | "grocery_stores_supermarkets" | "hardware_equipment_and_supplies" | "hardware_stores" | "health_and_beauty_spas" | "hearing_aids_sales_and_supplies" | "heating_plumbing_a_c" | "hobby_toy_and_game_shops" | "home_supply_warehouse_stores" | "hospitals" | "hotels_motels_and_resorts" | "household_appliance_stores" | "industrial_supplies" | "information_retrieval_services" | "insurance_default" | "insurance_underwriting_premiums" | "intra_company_purchases" | "jewelry_stores_watches_clocks_and_silverware_stores" | "landscaping_services" | "laundries" | "laundry_cleaning_services" | "legal_services_attorneys" | "luggage_and_leather_goods_stores" | "lumber_building_materials_stores" | "manual_cash_disburse" | "marinas_service_and_supplies" | "masonry_stonework_and_plaster" | "massage_parlors" | "medical_and_dental_labs" | "medical_dental_ophthalmic_and_hospital_equipment_and_supplies" | "medical_services" | "membership_organizations" | "mens_and_boys_clothing_and_accessories_stores" | "mens_womens_clothing_stores" | "metal_service_centers" | "miscellaneous" | "miscellaneous_apparel_and_accessory_shops" | "miscellaneous_auto_dealers" | "miscellaneous_business_services" | "miscellaneous_food_stores" | "miscellaneous_general_merchandise" | "miscellaneous_general_services" | "miscellaneous_home_furnishing_specialty_stores" | "miscellaneous_publishing_and_printing" | "miscellaneous_recreation_services" | "miscellaneous_repair_shops" | "miscellaneous_specialty_retail" | "mobile_home_dealers" | "motion_picture_theaters" | "motor_freight_carriers_and_trucking" | "motor_homes_dealers" | "motor_vehicle_supplies_and_new_parts" | "motorcycle_shops_and_dealers" | "motorcycle_shops_dealers" | "music_stores_musical_instruments_pianos_and_sheet_music" | "news_dealers_and_newsstands" | "non_fi_money_orders" | "non_fi_stored_value_card_purchase_load" | "nondurable_goods" | "nurseries_lawn_and_garden_supply_stores" | "nursing_personal_care" | "office_and_commercial_furniture" | "opticians_eyeglasses" | "optometrists_ophthalmologist" | "orthopedic_goods_prosthetic_devices" | "osteopaths" | "package_stores_beer_wine_and_liquor" | "paints_varnishes_and_supplies" | "parking_lots_garages" | "passenger_railways" | "pawn_shops" | "pet_shops_pet_food_and_supplies" | "petroleum_and_petroleum_products" | "photo_developing" | "photographic_photocopy_microfilm_equipment_and_supplies" | "photographic_studios" | "picture_video_production" | "piece_goods_notions_and_other_dry_goods" | "plumbing_heating_equipment_and_supplies" | "political_organizations" | "postal_services_government_only" | "precious_stones_and_metals_watches_and_jewelry" | "professional_services" | "public_warehousing_and_storage" | "quick_copy_repro_and_blueprint" | "railroads" | "real_estate_agents_and_managers_rentals" | "record_stores" | "recreational_vehicle_rentals" | "religious_goods_stores" | "religious_organizations" | "roofing_siding_sheet_metal" | "secretarial_support_services" | "security_brokers_dealers" | "service_stations" | "sewing_needlework_fabric_and_piece_goods_stores" | "shoe_repair_hat_cleaning" | "shoe_stores" | "small_appliance_repair" | "snowmobile_dealers" | "special_trade_services" | "specialty_cleaning" | "sporting_goods_stores" | "sporting_recreation_camps" | "sports_and_riding_apparel_stores" | "sports_clubs_fields" | "stamp_and_coin_stores" | "stationary_office_supplies_printing_and_writing_paper" | "stationery_stores_office_and_school_supply_stores" | "swimming_pools_sales" | "t_ui_travel_germany" | "tailors_alterations" | "tax_payments_government_agencies" | "tax_preparation_services" | "taxicabs_limousines" | "telecommunication_equipment_and_telephone_sales" | "telecommunication_services" | "telegraph_services" | "tent_and_awning_shops" | "testing_laboratories" | "theatrical_ticket_agencies" | "timeshares" | "tire_retreading_and_repair" | "tolls_bridge_fees" | "tourist_attractions_and_exhibits" | "towing_services" | "trailer_parks_campgrounds" | "transportation_services" | "travel_agencies_tour_operators" | "truck_stop_iteration" | "truck_utility_trailer_rentals" | "typesetting_plate_making_and_related_services" | "typewriter_stores" | "u_s_federal_government_agencies_or_departments" | "uniforms_commercial_clothing" | "used_merchandise_and_secondhand_stores" | "utilities" | "variety_stores" | "veterinary_services" | "video_amusement_game_supplies" | "video_game_arcades" | "video_tape_rental_stores" | "vocational_trade_schools" | "watch_jewelry_repair" | "welding_repair" | "wholesale_clubs" | "wig_and_toupee_stores" | "wires_money_orders" | "womens_accessory_and_specialty_shops" | "womens_ready_to_wear_stores" | "wrecking_and_salvage_yards")[] | null)
  /**
   * Limit spending with amount-based rules that apply across any cards this card replaced (i.e., its `replacement_for` card and _that_ card's `replacement_for` card, up the chain).
   */
  spending_limits?: (IssuingCardSpendingLimit[] | null)
  /**
   * Currency of the amounts within `spending_limits`. Always the same as the currency of the card.
   */
  spending_limits_currency?: (string | null)
}
export interface IssuingCardSpendingLimit {
  /**
   * Maximum amount allowed to spend per interval. This amount is in the card's currency and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  amount: number
  /**
   * Array of strings containing [categories](https://stripe.com/docs/api#issuing_authorization_object-merchant_data-category) this limit applies to. Omitting this field will apply the limit to all categories.
   */
  categories?: (("ac_refrigeration_repair" | "accounting_bookkeeping_services" | "advertising_services" | "agricultural_cooperative" | "airlines_air_carriers" | "airports_flying_fields" | "ambulance_services" | "amusement_parks_carnivals" | "antique_reproductions" | "antique_shops" | "aquariums" | "architectural_surveying_services" | "art_dealers_and_galleries" | "artists_supply_and_craft_shops" | "auto_and_home_supply_stores" | "auto_body_repair_shops" | "auto_paint_shops" | "auto_service_shops" | "automated_cash_disburse" | "automated_fuel_dispensers" | "automobile_associations" | "automotive_parts_and_accessories_stores" | "automotive_tire_stores" | "bail_and_bond_payments" | "bakeries" | "bands_orchestras" | "barber_and_beauty_shops" | "betting_casino_gambling" | "bicycle_shops" | "billiard_pool_establishments" | "boat_dealers" | "boat_rentals_and_leases" | "book_stores" | "books_periodicals_and_newspapers" | "bowling_alleys" | "bus_lines" | "business_secretarial_schools" | "buying_shopping_services" | "cable_satellite_and_other_pay_television_and_radio" | "camera_and_photographic_supply_stores" | "candy_nut_and_confectionery_stores" | "car_and_truck_dealers_new_used" | "car_and_truck_dealers_used_only" | "car_rental_agencies" | "car_washes" | "carpentry_services" | "carpet_upholstery_cleaning" | "caterers" | "charitable_and_social_service_organizations_fundraising" | "chemicals_and_allied_products" | "child_care_services" | "childrens_and_infants_wear_stores" | "chiropodists_podiatrists" | "chiropractors" | "cigar_stores_and_stands" | "civic_social_fraternal_associations" | "cleaning_and_maintenance" | "clothing_rental" | "colleges_universities" | "commercial_equipment" | "commercial_footwear" | "commercial_photography_art_and_graphics" | "commuter_transport_and_ferries" | "computer_network_services" | "computer_programming" | "computer_repair" | "computer_software_stores" | "computers_peripherals_and_software" | "concrete_work_services" | "construction_materials" | "consulting_public_relations" | "correspondence_schools" | "cosmetic_stores" | "counseling_services" | "country_clubs" | "courier_services" | "court_costs" | "credit_reporting_agencies" | "cruise_lines" | "dairy_products_stores" | "dance_hall_studios_schools" | "dating_escort_services" | "dentists_orthodontists" | "department_stores" | "detective_agencies" | "digital_goods_applications" | "digital_goods_games" | "digital_goods_large_volume" | "digital_goods_media" | "direct_marketing_catalog_merchant" | "direct_marketing_combination_catalog_and_retail_merchant" | "direct_marketing_inbound_telemarketing" | "direct_marketing_insurance_services" | "direct_marketing_other" | "direct_marketing_outbound_telemarketing" | "direct_marketing_subscription" | "direct_marketing_travel" | "discount_stores" | "doctors" | "door_to_door_sales" | "drapery_window_covering_and_upholstery_stores" | "drinking_places" | "drug_stores_and_pharmacies" | "drugs_drug_proprietaries_and_druggist_sundries" | "dry_cleaners" | "durable_goods" | "duty_free_stores" | "eating_places_restaurants" | "educational_services" | "electric_razor_stores" | "electrical_parts_and_equipment" | "electrical_services" | "electronics_repair_shops" | "electronics_stores" | "elementary_secondary_schools" | "employment_temp_agencies" | "equipment_rental" | "exterminating_services" | "family_clothing_stores" | "fast_food_restaurants" | "financial_institutions" | "fines_government_administrative_entities" | "fireplace_fireplace_screens_and_accessories_stores" | "floor_covering_stores" | "florists" | "florists_supplies_nursery_stock_and_flowers" | "freezer_and_locker_meat_provisioners" | "fuel_dealers_non_automotive" | "funeral_services_crematories" | "furniture_home_furnishings_and_equipment_stores_except_appliances" | "furniture_repair_refinishing" | "furriers_and_fur_shops" | "general_services" | "gift_card_novelty_and_souvenir_shops" | "glass_paint_and_wallpaper_stores" | "glassware_crystal_stores" | "golf_courses_public" | "government_services" | "grocery_stores_supermarkets" | "hardware_equipment_and_supplies" | "hardware_stores" | "health_and_beauty_spas" | "hearing_aids_sales_and_supplies" | "heating_plumbing_a_c" | "hobby_toy_and_game_shops" | "home_supply_warehouse_stores" | "hospitals" | "hotels_motels_and_resorts" | "household_appliance_stores" | "industrial_supplies" | "information_retrieval_services" | "insurance_default" | "insurance_underwriting_premiums" | "intra_company_purchases" | "jewelry_stores_watches_clocks_and_silverware_stores" | "landscaping_services" | "laundries" | "laundry_cleaning_services" | "legal_services_attorneys" | "luggage_and_leather_goods_stores" | "lumber_building_materials_stores" | "manual_cash_disburse" | "marinas_service_and_supplies" | "masonry_stonework_and_plaster" | "massage_parlors" | "medical_and_dental_labs" | "medical_dental_ophthalmic_and_hospital_equipment_and_supplies" | "medical_services" | "membership_organizations" | "mens_and_boys_clothing_and_accessories_stores" | "mens_womens_clothing_stores" | "metal_service_centers" | "miscellaneous" | "miscellaneous_apparel_and_accessory_shops" | "miscellaneous_auto_dealers" | "miscellaneous_business_services" | "miscellaneous_food_stores" | "miscellaneous_general_merchandise" | "miscellaneous_general_services" | "miscellaneous_home_furnishing_specialty_stores" | "miscellaneous_publishing_and_printing" | "miscellaneous_recreation_services" | "miscellaneous_repair_shops" | "miscellaneous_specialty_retail" | "mobile_home_dealers" | "motion_picture_theaters" | "motor_freight_carriers_and_trucking" | "motor_homes_dealers" | "motor_vehicle_supplies_and_new_parts" | "motorcycle_shops_and_dealers" | "motorcycle_shops_dealers" | "music_stores_musical_instruments_pianos_and_sheet_music" | "news_dealers_and_newsstands" | "non_fi_money_orders" | "non_fi_stored_value_card_purchase_load" | "nondurable_goods" | "nurseries_lawn_and_garden_supply_stores" | "nursing_personal_care" | "office_and_commercial_furniture" | "opticians_eyeglasses" | "optometrists_ophthalmologist" | "orthopedic_goods_prosthetic_devices" | "osteopaths" | "package_stores_beer_wine_and_liquor" | "paints_varnishes_and_supplies" | "parking_lots_garages" | "passenger_railways" | "pawn_shops" | "pet_shops_pet_food_and_supplies" | "petroleum_and_petroleum_products" | "photo_developing" | "photographic_photocopy_microfilm_equipment_and_supplies" | "photographic_studios" | "picture_video_production" | "piece_goods_notions_and_other_dry_goods" | "plumbing_heating_equipment_and_supplies" | "political_organizations" | "postal_services_government_only" | "precious_stones_and_metals_watches_and_jewelry" | "professional_services" | "public_warehousing_and_storage" | "quick_copy_repro_and_blueprint" | "railroads" | "real_estate_agents_and_managers_rentals" | "record_stores" | "recreational_vehicle_rentals" | "religious_goods_stores" | "religious_organizations" | "roofing_siding_sheet_metal" | "secretarial_support_services" | "security_brokers_dealers" | "service_stations" | "sewing_needlework_fabric_and_piece_goods_stores" | "shoe_repair_hat_cleaning" | "shoe_stores" | "small_appliance_repair" | "snowmobile_dealers" | "special_trade_services" | "specialty_cleaning" | "sporting_goods_stores" | "sporting_recreation_camps" | "sports_and_riding_apparel_stores" | "sports_clubs_fields" | "stamp_and_coin_stores" | "stationary_office_supplies_printing_and_writing_paper" | "stationery_stores_office_and_school_supply_stores" | "swimming_pools_sales" | "t_ui_travel_germany" | "tailors_alterations" | "tax_payments_government_agencies" | "tax_preparation_services" | "taxicabs_limousines" | "telecommunication_equipment_and_telephone_sales" | "telecommunication_services" | "telegraph_services" | "tent_and_awning_shops" | "testing_laboratories" | "theatrical_ticket_agencies" | "timeshares" | "tire_retreading_and_repair" | "tolls_bridge_fees" | "tourist_attractions_and_exhibits" | "towing_services" | "trailer_parks_campgrounds" | "transportation_services" | "travel_agencies_tour_operators" | "truck_stop_iteration" | "truck_utility_trailer_rentals" | "typesetting_plate_making_and_related_services" | "typewriter_stores" | "u_s_federal_government_agencies_or_departments" | "uniforms_commercial_clothing" | "used_merchandise_and_secondhand_stores" | "utilities" | "variety_stores" | "veterinary_services" | "video_amusement_game_supplies" | "video_game_arcades" | "video_tape_rental_stores" | "vocational_trade_schools" | "watch_jewelry_repair" | "welding_repair" | "wholesale_clubs" | "wig_and_toupee_stores" | "wires_money_orders" | "womens_accessory_and_specialty_shops" | "womens_ready_to_wear_stores" | "wrecking_and_salvage_yards")[] | null)
  /**
   * Interval (or event) to which the amount applies.
   */
  interval: ("all_time" | "daily" | "monthly" | "per_authorization" | "weekly" | "yearly")
}
export interface IssuingCardWallets {
  apple_pay: IssuingCardApplePay
  google_pay: IssuingCardGooglePay
  /**
   * Unique identifier for a card used with digital wallets
   */
  primary_account_identifier?: (string | null)
}
export interface IssuingCardApplePay {
  /**
   * Apple Pay Eligibility
   */
  eligible: boolean
  /**
   * Reason the card is ineligible for Apple Pay
   */
  ineligible_reason?: ("missing_agreement" | "missing_cardholder_contact" | "unsupported_region" | null)
}
export interface IssuingCardGooglePay {
  /**
   * Google Pay Eligibility
   */
  eligible: boolean
  /**
   * Reason the card is ineligible for Google Pay
   */
  ineligible_reason?: ("missing_agreement" | "missing_cardholder_contact" | "unsupported_region" | null)
}
export interface IssuingAuthorizationMerchantData {
  /**
   * A categorization of the seller's type of business. See our [merchant categories guide](https://stripe.com/docs/issuing/merchant-categories) for a list of possible values.
   */
  category: string
  /**
   * The merchant category code for the seller’s business
   */
  category_code: string
  /**
   * City where the seller is located
   */
  city?: (string | null)
  /**
   * Country where the seller is located
   */
  country?: (string | null)
  /**
   * Name of the seller
   */
  name?: (string | null)
  /**
   * Identifier assigned to the seller by the card network. Different card networks may assign different network_id fields to the same merchant.
   */
  network_id: string
  /**
   * Postal code where the seller is located
   */
  postal_code?: (string | null)
  /**
   * State where the seller is located
   */
  state?: (string | null)
}
export interface IssuingAuthorizationNetworkData {
  /**
   * Identifier assigned to the acquirer by the card network. Sometimes this value is not provided by the network; in this case, the value will be `null`.
   */
  acquiring_institution_id?: (string | null)
}
export interface IssuingAuthorizationPendingRequest {
  /**
   * The additional amount Stripe will hold if the authorization is approved, in the card's [currency](https://stripe.com/docs/api#issuing_authorization_object-pending-request-currency) and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  amount: number
  /**
   * Detailed breakdown of amount components. These amounts are denominated in `currency` and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  amount_details?: (IssuingAuthorizationAmountDetails | null)
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * If set `true`, you may provide [amount](https://stripe.com/docs/api/issuing/authorizations/approve#approve_issuing_authorization-amount) to control how much to hold for the authorization.
   */
  is_amount_controllable: boolean
  /**
   * The amount the merchant is requesting to be authorized in the `merchant_currency`. The amount is in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  merchant_amount: number
  /**
   * The local currency the merchant is requesting to authorize.
   */
  merchant_currency: string
}
export interface IssuingAuthorizationRequest {
  /**
   * The `pending_request.amount` at the time of the request, presented in your card's currency and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal). Stripe held this amount from your account to fund the authorization if the request was approved.
   */
  amount: number
  /**
   * Detailed breakdown of amount components. These amounts are denominated in `currency` and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  amount_details?: (IssuingAuthorizationAmountDetails | null)
  /**
   * Whether this request was approved.
   */
  approved: boolean
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * The `pending_request.merchant_amount` at the time of the request, presented in the `merchant_currency` and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  merchant_amount: number
  /**
   * The currency that was collected by the merchant and presented to the cardholder for the authorization. Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  merchant_currency: string
  /**
   * When an authorization is approved or declined by you or by Stripe, this field provides additional detail on the reason for the outcome.
   */
  reason: ("account_disabled" | "card_active" | "card_inactive" | "cardholder_inactive" | "cardholder_verification_required" | "insufficient_funds" | "not_allowed" | "spending_controls" | "suspected_fraud" | "verification_failed" | "webhook_approved" | "webhook_declined" | "webhook_error" | "webhook_timeout")
  /**
   * If approve/decline decision is directly responsed to the webhook with json payload and if the response is invalid (e.g., parsing errors), we surface the detailed message via this field.
   */
  reason_message?: (string | null)
}
/**
 * Any use of an [issued card](https://stripe.com/docs/issuing) that results in funds entering or leaving
 * your Stripe account, such as a completed purchase or refund, is represented by an Issuing
 * `Transaction` object.
 * 
 * Related guide: [Issued Card Transactions](https://stripe.com/docs/issuing/purchases/transactions).
 */
export interface IssuingTransaction {
  /**
   * The transaction amount, which will be reflected in your balance. This amount is in your currency and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  amount: number
  /**
   * Detailed breakdown of amount components. These amounts are denominated in `currency` and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal).
   */
  amount_details?: (IssuingTransactionAmountDetails | null)
  /**
   * The `Authorization` object that led to this transaction.
   */
  authorization?: (string | IssuingAuthorization | null)
  /**
   * ID of the [balance transaction](https://stripe.com/docs/api/balance_transactions) associated with this transaction.
   */
  balance_transaction?: (string | BalanceTransaction | null)
  /**
   * The card used to make this transaction.
   */
  card: (string | IssuingCard)
  /**
   * The cardholder to whom this transaction belongs.
   */
  cardholder?: (string | IssuingCardholder | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * If you've disputed the transaction, the ID of the dispute.
   */
  dispute?: (string | IssuingDispute | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * The amount that the merchant will receive, denominated in `merchant_currency` and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal). It will be different from `amount` if the merchant is taking payment in a different currency.
   */
  merchant_amount: number
  /**
   * The currency with which the merchant is taking payment.
   */
  merchant_currency: string
  merchant_data: IssuingAuthorizationMerchantData
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "issuing.transaction"
  /**
   * Additional purchase information that is optionally provided by the merchant.
   */
  purchase_details?: (IssuingTransactionPurchaseDetails | null)
  /**
   * [Treasury](https://stripe.com/docs/api/treasury) details related to this transaction if it was created on a [FinancialAccount](/docs/api/treasury/financial_accounts
   */
  treasury?: (IssuingTransactionTreasury | null)
  /**
   * The nature of the transaction.
   */
  type: ("capture" | "refund")
  /**
   * The digital wallet used for this transaction. One of `apple_pay`, `google_pay`, or `samsung_pay`.
   */
  wallet?: ("apple_pay" | "google_pay" | "samsung_pay" | null)
}
export interface IssuingTransactionAmountDetails {
  /**
   * The fee charged by the ATM for the cash withdrawal.
   */
  atm_fee?: (number | null)
}
/**
 * As a [card issuer](https://stripe.com/docs/issuing), you can dispute transactions that the cardholder does not recognize, suspects to be fraudulent, or has other issues with.
 * 
 * Related guide: [Disputing Transactions](https://stripe.com/docs/issuing/purchases/disputes)
 */
export interface IssuingDispute {
  /**
   * Disputed amount in the card's currency and in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal). Usually the amount of the `transaction`, but can differ (usually because of currency fluctuation).
   */
  amount: number
  /**
   * List of balance transactions associated with the dispute.
   */
  balance_transactions?: (BalanceTransaction[] | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * The currency the `transaction` was made in.
   */
  currency: string
  evidence: IssuingDisputeEvidence
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "issuing.dispute"
  /**
   * Current status of the dispute.
   */
  status: ("expired" | "lost" | "submitted" | "unsubmitted" | "won")
  /**
   * The transaction being disputed.
   */
  transaction: (string | IssuingTransaction)
  /**
   * [Treasury](https://stripe.com/docs/api/treasury) details related to this dispute if it was created on a [FinancialAccount](/docs/api/treasury/financial_accounts
   */
  treasury?: (IssuingDisputeTreasury | null)
}
export interface IssuingDisputeEvidence {
  canceled?: IssuingDisputeCanceledEvidence
  duplicate?: IssuingDisputeDuplicateEvidence
  fraudulent?: IssuingDisputeFraudulentEvidence
  merchandise_not_as_described?: IssuingDisputeMerchandiseNotAsDescribedEvidence
  not_received?: IssuingDisputeNotReceivedEvidence
  other?: IssuingDisputeOtherEvidence
  /**
   * The reason for filing the dispute. Its value will match the field containing the evidence.
   */
  reason: ("canceled" | "duplicate" | "fraudulent" | "merchandise_not_as_described" | "not_received" | "other" | "service_not_as_described")
  service_not_as_described?: IssuingDisputeServiceNotAsDescribedEvidence
}
export interface IssuingDisputeCanceledEvidence {
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Additional documentation supporting the dispute.
   */
  additional_documentation?: (string | File | null)
  /**
   * Date when order was canceled.
   */
  canceled_at?: (number | null)
  /**
   * Whether the cardholder was provided with a cancellation policy.
   */
  cancellation_policy_provided?: (boolean | null)
  /**
   * Reason for canceling the order.
   */
  cancellation_reason?: (string | null)
  /**
   * Date when the cardholder expected to receive the product.
   */
  expected_at?: (number | null)
  /**
   * Explanation of why the cardholder is disputing this transaction.
   */
  explanation?: (string | null)
  /**
   * Description of the merchandise or service that was purchased.
   */
  product_description?: (string | null)
  /**
   * Whether the product was a merchandise or service.
   */
  product_type?: ("merchandise" | "service" | null)
  /**
   * Result of cardholder's attempt to return the product.
   */
  return_status?: ("merchant_rejected" | "successful" | null)
  /**
   * Date when the product was returned or attempted to be returned.
   */
  returned_at?: (number | null)
}
export interface IssuingDisputeDuplicateEvidence {
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Additional documentation supporting the dispute.
   */
  additional_documentation?: (string | File | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Copy of the card statement showing that the product had already been paid for.
   */
  card_statement?: (string | File | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Copy of the receipt showing that the product had been paid for in cash.
   */
  cash_receipt?: (string | File | null)
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Image of the front and back of the check that was used to pay for the product.
   */
  check_image?: (string | File | null)
  /**
   * Explanation of why the cardholder is disputing this transaction.
   */
  explanation?: (string | null)
  /**
   * Transaction (e.g., ipi_...) that the disputed transaction is a duplicate of. Of the two or more transactions that are copies of each other, this is original undisputed one.
   */
  original_transaction?: (string | null)
}
export interface IssuingDisputeFraudulentEvidence {
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Additional documentation supporting the dispute.
   */
  additional_documentation?: (string | File | null)
  /**
   * Explanation of why the cardholder is disputing this transaction.
   */
  explanation?: (string | null)
}
export interface IssuingDisputeMerchandiseNotAsDescribedEvidence {
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Additional documentation supporting the dispute.
   */
  additional_documentation?: (string | File | null)
  /**
   * Explanation of why the cardholder is disputing this transaction.
   */
  explanation?: (string | null)
  /**
   * Date when the product was received.
   */
  received_at?: (number | null)
  /**
   * Description of the cardholder's attempt to return the product.
   */
  return_description?: (string | null)
  /**
   * Result of cardholder's attempt to return the product.
   */
  return_status?: ("merchant_rejected" | "successful" | null)
  /**
   * Date when the product was returned or attempted to be returned.
   */
  returned_at?: (number | null)
}
export interface IssuingDisputeNotReceivedEvidence {
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Additional documentation supporting the dispute.
   */
  additional_documentation?: (string | File | null)
  /**
   * Date when the cardholder expected to receive the product.
   */
  expected_at?: (number | null)
  /**
   * Explanation of why the cardholder is disputing this transaction.
   */
  explanation?: (string | null)
  /**
   * Description of the merchandise or service that was purchased.
   */
  product_description?: (string | null)
  /**
   * Whether the product was a merchandise or service.
   */
  product_type?: ("merchandise" | "service" | null)
}
export interface IssuingDisputeOtherEvidence {
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Additional documentation supporting the dispute.
   */
  additional_documentation?: (string | File | null)
  /**
   * Explanation of why the cardholder is disputing this transaction.
   */
  explanation?: (string | null)
  /**
   * Description of the merchandise or service that was purchased.
   */
  product_description?: (string | null)
  /**
   * Whether the product was a merchandise or service.
   */
  product_type?: ("merchandise" | "service" | null)
}
export interface IssuingDisputeServiceNotAsDescribedEvidence {
  /**
   * (ID of a [file upload](https://stripe.com/docs/guides/file-upload)) Additional documentation supporting the dispute.
   */
  additional_documentation?: (string | File | null)
  /**
   * Date when order was canceled.
   */
  canceled_at?: (number | null)
  /**
   * Reason for canceling the order.
   */
  cancellation_reason?: (string | null)
  /**
   * Explanation of why the cardholder is disputing this transaction.
   */
  explanation?: (string | null)
  /**
   * Date when the product was received.
   */
  received_at?: (number | null)
}
export interface IssuingDisputeTreasury {
  /**
   * The Treasury [DebitReversal](https://stripe.com/docs/api/treasury/debit_reversals) representing this Issuing dispute
   */
  debit_reversal?: (string | null)
  /**
   * The Treasury [ReceivedDebit](https://stripe.com/docs/api/treasury/received_debits) that is being disputed.
   */
  received_debit: string
}
export interface IssuingTransactionPurchaseDetails {
  /**
   * Information about the flight that was purchased with this transaction.
   */
  flight?: (IssuingTransactionFlightData | null)
  /**
   * Information about fuel that was purchased with this transaction.
   */
  fuel?: (IssuingTransactionFuelData | null)
  /**
   * Information about lodging that was purchased with this transaction.
   */
  lodging?: (IssuingTransactionLodgingData | null)
  /**
   * The line items in the purchase.
   */
  receipt?: (IssuingTransactionReceiptData[] | null)
  /**
   * A merchant-specific order number.
   */
  reference?: (string | null)
}
export interface IssuingTransactionFlightData {
  /**
   * The time that the flight departed.
   */
  departure_at?: (number | null)
  /**
   * The name of the passenger.
   */
  passenger_name?: (string | null)
  /**
   * Whether the ticket is refundable.
   */
  refundable?: (boolean | null)
  /**
   * The legs of the trip.
   */
  segments?: (IssuingTransactionFlightDataLeg[] | null)
  /**
   * The travel agency that issued the ticket.
   */
  travel_agency?: (string | null)
}
export interface IssuingTransactionFlightDataLeg {
  /**
   * The three-letter IATA airport code of the flight's destination.
   */
  arrival_airport_code?: (string | null)
  /**
   * The airline carrier code.
   */
  carrier?: (string | null)
  /**
   * The three-letter IATA airport code that the flight departed from.
   */
  departure_airport_code?: (string | null)
  /**
   * The flight number.
   */
  flight_number?: (string | null)
  /**
   * The flight's service class.
   */
  service_class?: (string | null)
  /**
   * Whether a stopover is allowed on this flight.
   */
  stopover_allowed?: (boolean | null)
}
export interface IssuingTransactionFuelData {
  /**
   * The type of fuel that was purchased. One of `diesel`, `unleaded_plus`, `unleaded_regular`, `unleaded_super`, or `other`.
   */
  type: string
  /**
   * The units for `volume_decimal`. One of `us_gallon` or `liter`.
   */
  unit: string
  /**
   * The cost in cents per each unit of fuel, represented as a decimal string with at most 12 decimal places.
   */
  unit_cost_decimal: string
  /**
   * The volume of the fuel that was pumped, represented as a decimal string with at most 12 decimal places.
   */
  volume_decimal?: (string | null)
}
export interface IssuingTransactionLodgingData {
  /**
   * The time of checking into the lodging.
   */
  check_in_at?: (number | null)
  /**
   * The number of nights stayed at the lodging.
   */
  nights?: (number | null)
}
export interface IssuingTransactionReceiptData {
  /**
   * The description of the item. The maximum length of this field is 26 characters.
   */
  description?: (string | null)
  /**
   * The quantity of the item.
   */
  quantity?: (number | null)
  /**
   * The total for this line item in cents.
   */
  total?: (number | null)
  /**
   * The unit cost of the item in cents.
   */
  unit_cost?: (number | null)
}
export interface IssuingTransactionTreasury {
  /**
   * The Treasury [ReceivedCredit](https://stripe.com/docs/api/treasury/received_credits) representing this Issuing transaction if it is a refund
   */
  received_credit?: (string | null)
  /**
   * The Treasury [ReceivedDebit](https://stripe.com/docs/api/treasury/received_debits) representing this Issuing transaction if it is a capture
   */
  received_debit?: (string | null)
}
export interface IssuingAuthorizationTreasury {
  /**
   * The array of [ReceivedCredits](https://stripe.com/docs/api/treasury/received_credits) associated with this authorization
   */
  received_credits: string[]
  /**
   * The array of [ReceivedDebits](https://stripe.com/docs/api/treasury/received_debits) associated with this authorization
   */
  received_debits: string[]
  /**
   * The Treasury [Transaction](https://stripe.com/docs/api/treasury/transactions) associated with this authorization
   */
  transaction?: (string | null)
}
export interface IssuingAuthorizationVerificationData {
  /**
   * Whether the cardholder provided an address first line and if it matched the cardholder’s `billing.address.line1`.
   */
  address_line1_check: ("match" | "mismatch" | "not_provided")
  /**
   * Whether the cardholder provided a postal code and if it matched the cardholder’s `billing.address.postal_code`.
   */
  address_postal_code_check: ("match" | "mismatch" | "not_provided")
  /**
   * Whether the cardholder provided a CVC and if it matched Stripe’s record.
   */
  cvc_check: ("match" | "mismatch" | "not_provided")
  /**
   * Whether the cardholder provided an expiry date and if it matched Stripe’s record.
   */
  expiry_check: ("match" | "mismatch" | "not_provided")
}
/**
 * A `Payout` object is created when you receive funds from Stripe, or when you
 * initiate a payout to either a bank account or debit card of a [connected
 * Stripe account](/docs/connect/bank-debit-card-payouts). You can retrieve individual payouts,
 * as well as list all payouts. Payouts are made on [varying
 * schedules](/docs/connect/manage-payout-schedule), depending on your country and
 * industry.
 * 
 * Related guide: [Receiving Payouts](https://stripe.com/docs/payouts).
 */
export interface Payout {
  /**
   * Amount (in %s) to be transferred to your bank account or debit card.
   */
  amount: number
  /**
   * Date the payout is expected to arrive in the bank. This factors in delays like weekends or bank holidays.
   */
  arrival_date: number
  /**
   * Returns `true` if the payout was created by an [automated payout schedule](https://stripe.com/docs/payouts#payout-schedule), and `false` if it was [requested manually](https://stripe.com/docs/payouts#manual-payouts).
   */
  automatic: boolean
  /**
   * ID of the balance transaction that describes the impact of this payout on your account balance.
   */
  balance_transaction?: (string | BalanceTransaction | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * ID of the bank account or card the payout was sent to.
   */
  destination?: (string | BankAccount | Card | DeletedBankAccount | DeletedCard | null)
  /**
   * If the payout failed or was canceled, this will be the ID of the balance transaction that reversed the initial balance transaction, and puts the funds from the failed payout back in your balance.
   */
  failure_balance_transaction?: (string | BalanceTransaction | null)
  /**
   * Error code explaining reason for payout failure if available. See [Types of payout failures](https://stripe.com/docs/api#payout_failures) for a list of failure codes.
   */
  failure_code?: (string | null)
  /**
   * Message to user further explaining reason for payout failure if available.
   */
  failure_message?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * The method used to send this payout, which can be `standard` or `instant`. `instant` is only supported for payouts to debit cards. (See [Instant payouts for marketplaces](https://stripe.com/blog/instant-payouts-for-marketplaces) for more information.)
   */
  method: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "payout"
  /**
   * If the payout reverses another, this is the ID of the original payout.
   */
  original_payout?: (string | Payout | null)
  /**
   * If the payout was reversed, this is the ID of the payout that reverses this payout.
   */
  reversed_by?: (string | Payout | null)
  /**
   * The source balance this payout came from. One of `card`, `fpx`, or `bank_account`.
   */
  source_type: string
  /**
   * Extra information about a payout to be displayed on the user's bank statement.
   */
  statement_descriptor?: (string | null)
  /**
   * Current status of the payout: `paid`, `pending`, `in_transit`, `canceled` or `failed`. A payout is `pending` until it is submitted to the bank, when it becomes `in_transit`. The status then changes to `paid` if the transaction goes through, or to `failed` or `canceled` (within 5 business days). Some failed payouts may initially show as `paid` but then change to `failed`.
   */
  status: string
  /**
   * Can be `bank_account` or `card`.
   */
  type: ("bank_account" | "card")
}
export interface DeletedBankAccount {
  /**
   * Three-letter [ISO code for the currency](https://stripe.com/docs/payouts) paid out to the bank account.
   */
  currency?: (string | null)
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "bank_account"
}
export interface DeletedCard {
  /**
   * Three-letter [ISO code for the currency](https://stripe.com/docs/payouts) paid out to the bank account.
   */
  currency?: (string | null)
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "card"
}
export interface PlatformTax {
  /**
   * The Connected account that incurred this charge.
   */
  account: string
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "platform_tax_fee"
  /**
   * The payment object that caused this tax to be inflicted.
   */
  source_transaction: string
  /**
   * The type of tax (VAT).
   */
  type: string
}
/**
 * `Refund` objects allow you to refund a charge that has previously been created
 * but not yet refunded. Funds will be refunded to the credit or debit card that
 * was originally charged.
 * 
 * Related guide: [Refunds](https://stripe.com/docs/refunds).
 */
export interface Refund {
  /**
   * Amount, in %s.
   */
  amount: number
  /**
   * Balance transaction that describes the impact on your account balance.
   */
  balance_transaction?: (string | BalanceTransaction | null)
  /**
   * ID of the charge that was refunded.
   */
  charge?: (string | Charge | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users. (Available on non-card refunds only)
   */
  description?: string
  /**
   * If the refund failed, this balance transaction describes the adjustment made on your account balance that reverses the initial balance transaction.
   */
  failure_balance_transaction?: (string | BalanceTransaction)
  /**
   * If the refund failed, the reason for refund failure if known. Possible values are `lost_or_stolen_card`, `expired_or_canceled_card`, `charge_for_pending_refund_disputed`, `insufficient_funds`, `declined`, `merchant_request` or `unknown`.
   */
  failure_reason?: string
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Email to which refund instructions, if required, are sent to.
   */
  instructions_email?: string
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  next_action?: RefundNextAction
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "refund"
  /**
   * ID of the PaymentIntent that was refunded.
   */
  payment_intent?: (string | PaymentIntent | null)
  /**
   * Reason for the refund, either user-provided (`duplicate`, `fraudulent`, or `requested_by_customer`) or generated by Stripe internally (`expired_uncaptured_charge`).
   */
  reason?: ("duplicate" | "expired_uncaptured_charge" | "fraudulent" | "requested_by_customer" | null)
  /**
   * This is the transaction number that appears on email receipts sent for this refund.
   */
  receipt_number?: (string | null)
  /**
   * The transfer reversal that is associated with the refund. Only present if the charge came from another Stripe account. See the Connect documentation for details.
   */
  source_transfer_reversal?: (string | TransferReversal | null)
  /**
   * Status of the refund. For credit card refunds, this can be `pending`, `succeeded`, or `failed`. For other types of refunds, it can be `pending`, `requires_action`, `succeeded`, `failed`, or `canceled`. Refer to our [refunds](https://stripe.com/docs/refunds#failed-refunds) documentation for more details.
   */
  status?: (string | null)
  /**
   * If the accompanying transfer was reversed, the transfer reversal object. Only applicable if the charge was created using the destination parameter.
   */
  transfer_reversal?: (string | TransferReversal | null)
}
export interface RefundNextAction {
  /**
   * Contains the refund details.
   */
  display_details?: (RefundNextActionDisplayDetails | null)
  /**
   * Type of the next action to perform.
   */
  type: string
}
export interface RefundNextActionDisplayDetails {
  email_sent: EmailSent
  /**
   * The expiry timestamp.
   */
  expires_at: number
}
export interface EmailSent {
  /**
   * The timestamp when the email was sent.
   */
  email_sent_at: number
  /**
   * The recipient's email address.
   */
  email_sent_to: string
}
/**
 * [Stripe Connect](https://stripe.com/docs/connect) platforms can reverse transfers made to a
 * connected account, either entirely or partially, and can also specify whether
 * to refund any related application fees. Transfer reversals add to the
 * platform's balance and subtract from the destination account's balance.
 * 
 * Reversing a transfer that was made for a [destination
 * charge](/docs/connect/destination-charges) is allowed only up to the amount of
 * the charge. It is possible to reverse a
 * [transfer_group](https://stripe.com/docs/connect/charges-transfers#transfer-options)
 * transfer only if the destination account has enough balance to cover the
 * reversal.
 * 
 * Related guide: [Reversing Transfers](https://stripe.com/docs/connect/charges-transfers#reversing-transfers).
 */
export interface TransferReversal {
  /**
   * Amount, in %s.
   */
  amount: number
  /**
   * Balance transaction that describes the impact on your account balance.
   */
  balance_transaction?: (string | BalanceTransaction | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * Linked payment refund for the transfer reversal.
   */
  destination_payment_refund?: (string | Refund | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "transfer_reversal"
  /**
   * ID of the refund responsible for the transfer reversal.
   */
  source_refund?: (string | Refund | null)
  /**
   * ID of the transfer that was reversed.
   */
  transfer: (string | Transfer)
}
/**
 * A `Transfer` object is created when you move funds between Stripe accounts as
 * part of Connect.
 * 
 * Before April 6, 2017, transfers also represented movement of funds from a
 * Stripe account to a card or bank account. This behavior has since been split
 * out into a [Payout](https://stripe.com/docs/api#payout_object) object, with corresponding payout endpoints. For more
 * information, read about the
 * [transfer/payout split](https://stripe.com/docs/transfer-payout-split).
 * 
 * Related guide: [Creating Separate Charges and Transfers](https://stripe.com/docs/connect/charges-transfers).
 */
export interface Transfer {
  /**
   * Amount in %s to be transferred.
   */
  amount: number
  /**
   * Amount in %s reversed (can be less than the amount attribute on the transfer if a partial reversal was issued).
   */
  amount_reversed: number
  /**
   * Balance transaction that describes the impact of this transfer on your account balance.
   */
  balance_transaction?: (string | BalanceTransaction | null)
  /**
   * Time that this record of the transfer was first created.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * ID of the Stripe account the transfer was sent to.
   */
  destination?: (string | Account | null)
  /**
   * If the destination is a Stripe account, this will be the ID of the payment that the destination account received for the transfer.
   */
  destination_payment?: (string | Charge)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "transfer"
  reversals: TransferReversalList
  /**
   * Whether the transfer has been fully reversed. If the transfer is only partially reversed, this attribute will still be false.
   */
  reversed: boolean
  /**
   * ID of the charge or payment that was used to fund the transfer. If null, the transfer was funded from the available balance.
   */
  source_transaction?: (string | Charge | null)
  /**
   * The source balance this transfer came from. One of `card`, `fpx`, or `bank_account`.
   */
  source_type?: string
  /**
   * A string that identifies this transaction as part of a group. See the [Connect documentation](https://stripe.com/docs/connect/charges-transfers#transfer-options) for details.
   */
  transfer_group?: (string | null)
}
/**
 * A list of reversals that have been applied to the transfer.
 */
export interface TransferReversalList {
  /**
   * Details about each object.
   */
  data: TransferReversal[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
export interface ReserveTransaction {
  amount: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "reserve_transaction"
}
export interface TaxDeductedAtSource {
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "tax_deducted_at_source"
  /**
   * The end of the invoicing period. This TDS applies to Stripe fees collected during this invoicing period.
   */
  period_end: number
  /**
   * The start of the invoicing period. This TDS applies to Stripe fees collected during this invoicing period.
   */
  period_start: number
  /**
   * The TAN that was supplied to Stripe when TDS was assessed
   */
  tax_deduction_account_number: string
}
/**
 * To top up your Stripe balance, you create a top-up object. You can retrieve
 * individual top-ups, as well as list all top-ups. Top-ups are identified by a
 * unique, random ID.
 * 
 * Related guide: [Topping Up your Platform Account](https://stripe.com/docs/connect/top-ups).
 */
export interface Topup {
  /**
   * Amount transferred.
   */
  amount: number
  /**
   * ID of the balance transaction that describes the impact of this top-up on your account balance. May not be specified depending on status of top-up.
   */
  balance_transaction?: (string | BalanceTransaction | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * Date the funds are expected to arrive in your Stripe account for payouts. This factors in delays like weekends or bank holidays. May not be specified depending on status of top-up.
   */
  expected_availability_date?: (number | null)
  /**
   * Error code explaining reason for top-up failure if available (see [the errors section](https://stripe.com/docs/api#errors) for a list of codes).
   */
  failure_code?: (string | null)
  /**
   * Message to user further explaining reason for top-up failure if available.
   */
  failure_message?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "topup"
  /**
   * For most Stripe users, the source of every top-up is a bank account. This hash is then the [source object](https://stripe.com/docs/api#source_object) describing that bank account.
   */
  source?: (Source | null)
  /**
   * Extra information about a top-up. This will appear on your source's bank statement. It must contain at least one letter.
   */
  statement_descriptor?: (string | null)
  /**
   * The status of the top-up is either `canceled`, `failed`, `pending`, `reversed`, or `succeeded`.
   */
  status: ("canceled" | "failed" | "pending" | "reversed" | "succeeded")
  /**
   * A string that identifies this top-up as part of a group.
   */
  transfer_group?: (string | null)
}
/**
 * A list of refunds that have been applied to the fee.
 */
export interface FeeRefundList {
  /**
   * Details about each object.
   */
  data: FeeRefund[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
export interface ChargeFraudDetails {
  /**
   * Assessments from Stripe. If set, the value is `fraudulent`.
   */
  stripe_report?: string
  /**
   * Assessments reported by you. If set, possible values of are `safe` and `fraudulent`.
   */
  user_report?: string
}
export interface ChargeOutcome {
  /**
   * Possible values are `approved_by_network`, `declined_by_network`, `not_sent_to_network`, and `reversed_after_approval`. The value `reversed_after_approval` indicates the payment was [blocked by Stripe](https://stripe.com/docs/declines#blocked-payments) after bank authorization, and may temporarily appear as "pending" on a cardholder's statement.
   */
  network_status?: (string | null)
  /**
   * An enumerated value providing a more detailed explanation of the outcome's `type`. Charges blocked by Radar's default block rule have the value `highest_risk_level`. Charges placed in review by Radar's default review rule have the value `elevated_risk_level`. Charges authorized, blocked, or placed in review by custom rules have the value `rule`. See [understanding declines](https://stripe.com/docs/declines) for more details.
   */
  reason?: (string | null)
  /**
   * Stripe Radar's evaluation of the riskiness of the payment. Possible values for evaluated payments are `normal`, `elevated`, `highest`. For non-card payments, and card-based payments predating the public assignment of risk levels, this field will have the value `not_assessed`. In the event of an error in the evaluation, this field will have the value `unknown`. This field is only available with Radar.
   */
  risk_level?: string
  /**
   * Stripe Radar's evaluation of the riskiness of the payment. Possible values for evaluated payments are between 0 and 100. For non-card payments, card-based payments predating the public assignment of risk scores, or in the event of an error during evaluation, this field will not be present. This field is only available with Radar for Fraud Teams.
   */
  risk_score?: number
  /**
   * The ID of the Radar rule that matched the payment, if applicable.
   */
  rule?: (string | RadarRule)
  /**
   * A human-readable description of the outcome type and reason, designed for you (the recipient of the payment), not your customer.
   */
  seller_message?: (string | null)
  /**
   * Possible values are `authorized`, `manual_review`, `issuer_declined`, `blocked`, and `invalid`. See [understanding declines](https://stripe.com/docs/declines) and [Radar reviews](https://stripe.com/docs/radar/reviews) for details.
   */
  type: string
}
export interface RadarRule {
  /**
   * The action taken on the payment.
   */
  action: string
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The predicate to evaluate the payment against.
   */
  predicate: string
}
export interface PaymentMethodDetails {
  ach_credit_transfer?: PaymentMethodDetailsAchCreditTransfer
  ach_debit?: PaymentMethodDetailsAchDebit
  acss_debit?: PaymentMethodDetailsAcssDebit
  affirm?: PaymentMethodDetailsAffirm
  afterpay_clearpay?: PaymentMethodDetailsAfterpayClearpay
  alipay?: PaymentFlowsPrivatePaymentMethodsAlipayDetails
  au_becs_debit?: PaymentMethodDetailsAuBecsDebit
  bacs_debit?: PaymentMethodDetailsBacsDebit
  bancontact?: PaymentMethodDetailsBancontact
  blik?: PaymentMethodDetailsBlik
  boleto?: PaymentMethodDetailsBoleto
  card?: PaymentMethodDetailsCard
  card_present?: PaymentMethodDetailsCardPresent
  customer_balance?: PaymentMethodDetailsCustomerBalance
  eps?: PaymentMethodDetailsEps
  fpx?: PaymentMethodDetailsFpx
  giropay?: PaymentMethodDetailsGiropay
  grabpay?: PaymentMethodDetailsGrabpay
  ideal?: PaymentMethodDetailsIdeal
  interac_present?: PaymentMethodDetailsInteracPresent
  klarna?: PaymentMethodDetailsKlarna
  konbini?: PaymentMethodDetailsKonbini
  link?: PaymentMethodDetailsLink
  multibanco?: PaymentMethodDetailsMultibanco
  oxxo?: PaymentMethodDetailsOxxo
  p24?: PaymentMethodDetailsP24
  paynow?: PaymentMethodDetailsPaynow
  pix?: PaymentMethodDetailsPix
  promptpay?: PaymentMethodDetailsPromptpay
  sepa_debit?: PaymentMethodDetailsSepaDebit
  sofort?: PaymentMethodDetailsSofort
  stripe_account?: PaymentMethodDetailsStripeAccount
  /**
   * The type of transaction-specific details of the payment method used in the payment, one of `ach_credit_transfer`, `ach_debit`, `acss_debit`, `alipay`, `au_becs_debit`, `bancontact`, `card`, `card_present`, `eps`, `giropay`, `ideal`, `klarna`, `multibanco`, `p24`, `sepa_debit`, `sofort`, `stripe_account`, or `wechat`.
   * An additional hash is included on `payment_method_details` with a name matching this value.
   * It contains information specific to the payment method.
   */
  type: string
  us_bank_account?: PaymentMethodDetailsUsBankAccount
  wechat?: PaymentMethodDetailsWechat
  wechat_pay?: PaymentMethodDetailsWechatPay
}
export interface PaymentMethodDetailsAchCreditTransfer {
  /**
   * Account number to transfer funds to.
   */
  account_number?: (string | null)
  /**
   * Name of the bank associated with the routing number.
   */
  bank_name?: (string | null)
  /**
   * Routing transit number for the bank account to transfer funds to.
   */
  routing_number?: (string | null)
  /**
   * SWIFT code of the bank associated with the routing number.
   */
  swift_code?: (string | null)
}
export interface PaymentMethodDetailsAchDebit {
  /**
   * Type of entity that holds the account. This can be either `individual` or `company`.
   */
  account_holder_type?: ("company" | "individual" | null)
  /**
   * Name of the bank associated with the bank account.
   */
  bank_name?: (string | null)
  /**
   * Two-letter ISO code representing the country the bank account is located in.
   */
  country?: (string | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Last four digits of the bank account number.
   */
  last4?: (string | null)
  /**
   * Routing transit number of the bank account.
   */
  routing_number?: (string | null)
}
export interface PaymentMethodDetailsAcssDebit {
  /**
   * Name of the bank associated with the bank account.
   */
  bank_name?: (string | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Institution number of the bank account
   */
  institution_number?: (string | null)
  /**
   * Last four digits of the bank account number.
   */
  last4?: (string | null)
  /**
   * ID of the mandate used to make this payment.
   */
  mandate?: string
  /**
   * Transit number of the bank account.
   */
  transit_number?: (string | null)
}
export interface PaymentMethodDetailsAffirm {

}
export interface PaymentMethodDetailsAfterpayClearpay {
  /**
   * Order identifier shown to the merchant in Afterpay’s online portal.
   */
  reference?: (string | null)
}
export interface PaymentFlowsPrivatePaymentMethodsAlipayDetails {
  /**
   * Uniquely identifies this particular Alipay account. You can use this attribute to check whether two Alipay accounts are the same.
   */
  buyer_id?: string
  /**
   * Uniquely identifies this particular Alipay account. You can use this attribute to check whether two Alipay accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Transaction ID of this particular Alipay transaction.
   */
  transaction_id?: (string | null)
}
export interface PaymentMethodDetailsAuBecsDebit {
  /**
   * Bank-State-Branch number of the bank account.
   */
  bsb_number?: (string | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Last four digits of the bank account number.
   */
  last4?: (string | null)
  /**
   * ID of the mandate used to make this payment.
   */
  mandate?: string
}
export interface PaymentMethodDetailsBacsDebit {
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Last four digits of the bank account number.
   */
  last4?: (string | null)
  /**
   * ID of the mandate used to make this payment.
   */
  mandate?: (string | null)
  /**
   * Sort code of the bank account. (e.g., `10-20-30`)
   */
  sort_code?: (string | null)
}
export interface PaymentMethodDetailsBancontact {
  /**
   * Bank code of bank associated with the bank account.
   */
  bank_code?: (string | null)
  /**
   * Name of the bank associated with the bank account.
   */
  bank_name?: (string | null)
  /**
   * Bank Identifier Code of the bank associated with the bank account.
   */
  bic?: (string | null)
  /**
   * The ID of the SEPA Direct Debit PaymentMethod which was generated by this Charge.
   */
  generated_sepa_debit?: (string | PaymentMethod | null)
  /**
   * The mandate for the SEPA Direct Debit PaymentMethod which was generated by this Charge.
   */
  generated_sepa_debit_mandate?: (string | Mandate | null)
  /**
   * Last four characters of the IBAN.
   */
  iban_last4?: (string | null)
  /**
   * Preferred language of the Bancontact authorization page that the customer is redirected to.
   * Can be one of `en`, `de`, `fr`, or `nl`
   */
  preferred_language?: ("de" | "en" | "fr" | "nl" | null)
  /**
   * Owner's verified full name. Values are verified or provided by Bancontact directly
   * (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_name?: (string | null)
}
export interface PaymentMethodDetailsBlik {

}
export interface PaymentMethodDetailsBoleto {
  /**
   * The tax ID of the customer (CPF for individuals consumers or CNPJ for businesses consumers)
   */
  tax_id: string
}
export interface PaymentMethodDetailsCard {
  /**
   * Card brand. Can be `amex`, `diners`, `discover`, `jcb`, `mastercard`, `unionpay`, `visa`, or `unknown`.
   */
  brand?: (string | null)
  /**
   * Check results by Card networks on Card address and CVC at time of payment.
   */
  checks?: (PaymentMethodDetailsCardChecks | null)
  /**
   * Two-letter ISO code representing the country of the card. You could use this attribute to get a sense of the international breakdown of cards you've collected.
   */
  country?: (string | null)
  /**
   * Two-digit number representing the card's expiration month.
   */
  exp_month: number
  /**
   * Four-digit number representing the card's expiration year.
   */
  exp_year: number
  /**
   * Uniquely identifies this particular card number. You can use this attribute to check whether two customers who’ve signed up with you are using the same card number, for example. For payment methods that tokenize card information (Apple Pay, Google Pay), the tokenized number might be provided instead of the underlying card number.
   * 
   * *Starting May 1, 2021, card fingerprint in India for Connect will change to allow two fingerprints for the same card --- one for India and one for the rest of the world.*
   */
  fingerprint?: (string | null)
  /**
   * Card funding type. Can be `credit`, `debit`, `prepaid`, or `unknown`.
   */
  funding?: (string | null)
  /**
   * Installment details for this payment (Mexico only).
   * 
   * For more information, see the [installments integration guide](https://stripe.com/docs/payments/installments).
   */
  installments?: (PaymentMethodDetailsCardInstallments | null)
  /**
   * The last four digits of the card.
   */
  last4?: (string | null)
  /**
   * ID of the mandate used to make this payment or created by it.
   */
  mandate?: (string | null)
  /**
   * Identifies which network this charge was processed on. Can be `amex`, `cartes_bancaires`, `diners`, `discover`, `interac`, `jcb`, `mastercard`, `unionpay`, `visa`, or `unknown`.
   */
  network?: (string | null)
  /**
   * Populated if this transaction used 3D Secure authentication.
   */
  three_d_secure?: (ThreeDSecureDetails | null)
  /**
   * If this Card is part of a card wallet, this contains the details of the card wallet.
   */
  wallet?: (PaymentMethodDetailsCardWallet | null)
}
export interface PaymentMethodDetailsCardChecks {
  /**
   * If a address line1 was provided, results of the check, one of `pass`, `fail`, `unavailable`, or `unchecked`.
   */
  address_line1_check?: (string | null)
  /**
   * If a address postal code was provided, results of the check, one of `pass`, `fail`, `unavailable`, or `unchecked`.
   */
  address_postal_code_check?: (string | null)
  /**
   * If a CVC was provided, results of the check, one of `pass`, `fail`, `unavailable`, or `unchecked`.
   */
  cvc_check?: (string | null)
}
export interface PaymentMethodDetailsCardInstallments {
  /**
   * Installment plan selected for the payment.
   */
  plan?: (PaymentMethodDetailsCardInstallmentsPlan | null)
}
export interface PaymentMethodDetailsCardInstallmentsPlan {
  /**
   * For `fixed_count` installment plans, this is the number of installment payments your customer will make to their credit card.
   */
  count?: (number | null)
  /**
   * For `fixed_count` installment plans, this is the interval between installment payments your customer will make to their credit card.
   * One of `month`.
   */
  interval?: ("month" | null)
  /**
   * Type of installment plan, one of `fixed_count`.
   */
  type: "fixed_count"
}
export interface PaymentMethodDetailsCardWallet {
  amex_express_checkout?: PaymentMethodDetailsCardWalletAmexExpressCheckout
  apple_pay?: PaymentMethodDetailsCardWalletApplePay
  /**
   * (For tokenized numbers only.) The last four digits of the device account number.
   */
  dynamic_last4?: (string | null)
  google_pay?: PaymentMethodDetailsCardWalletGooglePay
  masterpass?: PaymentMethodDetailsCardWalletMasterpass
  samsung_pay?: PaymentMethodDetailsCardWalletSamsungPay
  /**
   * The type of the card wallet, one of `amex_express_checkout`, `apple_pay`, `google_pay`, `masterpass`, `samsung_pay`, or `visa_checkout`. An additional hash is included on the Wallet subhash with a name matching this value. It contains additional information specific to the card wallet type.
   */
  type: ("amex_express_checkout" | "apple_pay" | "google_pay" | "masterpass" | "samsung_pay" | "visa_checkout")
  visa_checkout?: PaymentMethodDetailsCardWalletVisaCheckout
}
export interface PaymentMethodDetailsCardWalletAmexExpressCheckout {

}
export interface PaymentMethodDetailsCardWalletApplePay {

}
export interface PaymentMethodDetailsCardWalletGooglePay {

}
export interface PaymentMethodDetailsCardWalletMasterpass {
  /**
   * Owner's verified billing address. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  billing_address?: (Address | null)
  /**
   * Owner's verified email. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  email?: (string | null)
  /**
   * Owner's verified full name. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  name?: (string | null)
  /**
   * Owner's verified shipping address. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  shipping_address?: (Address | null)
}
export interface PaymentMethodDetailsCardWalletSamsungPay {

}
export interface PaymentMethodDetailsCardWalletVisaCheckout {
  /**
   * Owner's verified billing address. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  billing_address?: (Address | null)
  /**
   * Owner's verified email. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  email?: (string | null)
  /**
   * Owner's verified full name. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  name?: (string | null)
  /**
   * Owner's verified shipping address. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  shipping_address?: (Address | null)
}
export interface PaymentMethodDetailsCustomerBalance {

}
export interface PaymentMethodDetailsEps {
  /**
   * The customer's bank. Should be one of `arzte_und_apotheker_bank`, `austrian_anadi_bank_ag`, `bank_austria`, `bankhaus_carl_spangler`, `bankhaus_schelhammer_und_schattera_ag`, `bawag_psk_ag`, `bks_bank_ag`, `brull_kallmus_bank_ag`, `btv_vier_lander_bank`, `capital_bank_grawe_gruppe_ag`, `deutsche_bank_ag`, `dolomitenbank`, `easybank_ag`, `erste_bank_und_sparkassen`, `hypo_alpeadriabank_international_ag`, `hypo_noe_lb_fur_niederosterreich_u_wien`, `hypo_oberosterreich_salzburg_steiermark`, `hypo_tirol_bank_ag`, `hypo_vorarlberg_bank_ag`, `hypo_bank_burgenland_aktiengesellschaft`, `marchfelder_bank`, `oberbank_ag`, `raiffeisen_bankengruppe_osterreich`, `schoellerbank_ag`, `sparda_bank_wien`, `volksbank_gruppe`, `volkskreditbank_ag`, or `vr_bank_braunau`.
   */
  bank?: ("arzte_und_apotheker_bank" | "austrian_anadi_bank_ag" | "bank_austria" | "bankhaus_carl_spangler" | "bankhaus_schelhammer_und_schattera_ag" | "bawag_psk_ag" | "bks_bank_ag" | "brull_kallmus_bank_ag" | "btv_vier_lander_bank" | "capital_bank_grawe_gruppe_ag" | "deutsche_bank_ag" | "dolomitenbank" | "easybank_ag" | "erste_bank_und_sparkassen" | "hypo_alpeadriabank_international_ag" | "hypo_bank_burgenland_aktiengesellschaft" | "hypo_noe_lb_fur_niederosterreich_u_wien" | "hypo_oberosterreich_salzburg_steiermark" | "hypo_tirol_bank_ag" | "hypo_vorarlberg_bank_ag" | "marchfelder_bank" | "oberbank_ag" | "raiffeisen_bankengruppe_osterreich" | "schoellerbank_ag" | "sparda_bank_wien" | "volksbank_gruppe" | "volkskreditbank_ag" | "vr_bank_braunau" | null)
  /**
   * Owner's verified full name. Values are verified or provided by EPS directly
   * (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   * EPS rarely provides this information so the attribute is usually empty.
   */
  verified_name?: (string | null)
}
export interface PaymentMethodDetailsFpx {
  /**
   * The customer's bank. Can be one of `affin_bank`, `agrobank`, `alliance_bank`, `ambank`, `bank_islam`, `bank_muamalat`, `bank_rakyat`, `bsn`, `cimb`, `hong_leong_bank`, `hsbc`, `kfh`, `maybank2u`, `ocbc`, `public_bank`, `rhb`, `standard_chartered`, `uob`, `deutsche_bank`, `maybank2e`, `pb_enterprise`, or `bank_of_china`.
   */
  bank: ("affin_bank" | "agrobank" | "alliance_bank" | "ambank" | "bank_islam" | "bank_muamalat" | "bank_of_china" | "bank_rakyat" | "bsn" | "cimb" | "deutsche_bank" | "hong_leong_bank" | "hsbc" | "kfh" | "maybank2e" | "maybank2u" | "ocbc" | "pb_enterprise" | "public_bank" | "rhb" | "standard_chartered" | "uob")
  /**
   * Unique transaction id generated by FPX for every request from the merchant
   */
  transaction_id?: (string | null)
}
export interface PaymentMethodDetailsGiropay {
  /**
   * Bank code of bank associated with the bank account.
   */
  bank_code?: (string | null)
  /**
   * Name of the bank associated with the bank account.
   */
  bank_name?: (string | null)
  /**
   * Bank Identifier Code of the bank associated with the bank account.
   */
  bic?: (string | null)
  /**
   * Owner's verified full name. Values are verified or provided by Giropay directly
   * (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   * Giropay rarely provides this information so the attribute is usually empty.
   */
  verified_name?: (string | null)
}
export interface PaymentMethodDetailsGrabpay {
  /**
   * Unique transaction id generated by GrabPay
   */
  transaction_id?: (string | null)
}
export interface PaymentMethodDetailsIdeal {
  /**
   * The customer's bank. Can be one of `abn_amro`, `asn_bank`, `bunq`, `handelsbanken`, `ing`, `knab`, `moneyou`, `rabobank`, `regiobank`, `revolut`, `sns_bank`, `triodos_bank`, `van_lanschot`, or `yoursafe`.
   */
  bank?: ("abn_amro" | "asn_bank" | "bunq" | "handelsbanken" | "ing" | "knab" | "moneyou" | "rabobank" | "regiobank" | "revolut" | "sns_bank" | "triodos_bank" | "van_lanschot" | "yoursafe" | null)
  /**
   * The Bank Identifier Code of the customer's bank.
   */
  bic?: ("ABNANL2A" | "ASNBNL21" | "BITSNL2A" | "BUNQNL2A" | "FVLBNL22" | "HANDNL2A" | "INGBNL2A" | "KNABNL2H" | "MOYONL21" | "RABONL2U" | "RBRBNL21" | "REVOLT21" | "SNSBNL2A" | "TRIONL2U" | null)
  /**
   * The ID of the SEPA Direct Debit PaymentMethod which was generated by this Charge.
   */
  generated_sepa_debit?: (string | PaymentMethod | null)
  /**
   * The mandate for the SEPA Direct Debit PaymentMethod which was generated by this Charge.
   */
  generated_sepa_debit_mandate?: (string | Mandate | null)
  /**
   * Last four characters of the IBAN.
   */
  iban_last4?: (string | null)
  /**
   * Owner's verified full name. Values are verified or provided by iDEAL directly
   * (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_name?: (string | null)
}
export interface PaymentMethodDetailsInteracPresent {
  /**
   * Card brand. Can be `interac`, `mastercard` or `visa`.
   */
  brand?: (string | null)
  /**
   * The cardholder name as read from the card, in [ISO 7813](https://en.wikipedia.org/wiki/ISO/IEC_7813) format. May include alphanumeric characters, special characters and first/last name separator (`/`). In some cases, the cardholder name may not be available depending on how the issuer has configured the card. Cardholder name is typically not available on swipe or contactless payments, such as those made with Apple Pay and Google Pay.
   */
  cardholder_name?: (string | null)
  /**
   * Two-letter ISO code representing the country of the card. You could use this attribute to get a sense of the international breakdown of cards you've collected.
   */
  country?: (string | null)
  /**
   * Authorization response cryptogram.
   */
  emv_auth_data?: (string | null)
  /**
   * Two-digit number representing the card's expiration month.
   */
  exp_month: number
  /**
   * Four-digit number representing the card's expiration year.
   */
  exp_year: number
  /**
   * Uniquely identifies this particular card number. You can use this attribute to check whether two customers who’ve signed up with you are using the same card number, for example. For payment methods that tokenize card information (Apple Pay, Google Pay), the tokenized number might be provided instead of the underlying card number.
   * 
   * *Starting May 1, 2021, card fingerprint in India for Connect will change to allow two fingerprints for the same card --- one for India and one for the rest of the world.*
   */
  fingerprint?: (string | null)
  /**
   * Card funding type. Can be `credit`, `debit`, `prepaid`, or `unknown`.
   */
  funding?: (string | null)
  /**
   * ID of a card PaymentMethod generated from the card_present PaymentMethod that may be attached to a Customer for future transactions. Only present if it was possible to generate a card PaymentMethod.
   */
  generated_card?: (string | null)
  /**
   * The last four digits of the card.
   */
  last4?: (string | null)
  /**
   * Identifies which network this charge was processed on. Can be `amex`, `cartes_bancaires`, `diners`, `discover`, `interac`, `jcb`, `mastercard`, `unionpay`, `visa`, or `unknown`.
   */
  network?: (string | null)
  /**
   * EMV tag 5F2D. Preferred languages specified by the integrated circuit chip.
   */
  preferred_locales?: (string[] | null)
  /**
   * How card details were read in this transaction.
   */
  read_method?: ("contact_emv" | "contactless_emv" | "contactless_magstripe_mode" | "magnetic_stripe_fallback" | "magnetic_stripe_track2" | null)
  /**
   * A collection of fields required to be displayed on receipts. Only required for EMV transactions.
   */
  receipt?: (PaymentMethodDetailsInteracPresentReceipt | null)
}
export interface PaymentMethodDetailsInteracPresentReceipt {
  /**
   * The type of account being debited or credited
   */
  account_type?: ("checking" | "savings" | "unknown")
  /**
   * EMV tag 9F26, cryptogram generated by the integrated circuit chip.
   */
  application_cryptogram?: (string | null)
  /**
   * Mnenomic of the Application Identifier.
   */
  application_preferred_name?: (string | null)
  /**
   * Identifier for this transaction.
   */
  authorization_code?: (string | null)
  /**
   * EMV tag 8A. A code returned by the card issuer.
   */
  authorization_response_code?: (string | null)
  /**
   * How the cardholder verified ownership of the card.
   */
  cardholder_verification_method?: (string | null)
  /**
   * EMV tag 84. Similar to the application identifier stored on the integrated circuit chip.
   */
  dedicated_file_name?: (string | null)
  /**
   * The outcome of a series of EMV functions performed by the card reader.
   */
  terminal_verification_results?: (string | null)
  /**
   * An indication of various EMV functions performed during the transaction.
   */
  transaction_status_information?: (string | null)
}
export interface PaymentMethodDetailsKlarna {
  /**
   * The Klarna payment method used for this transaction.
   * Can be one of `pay_later`, `pay_now`, `pay_with_financing`, or `pay_in_installments`
   */
  payment_method_category?: (string | null)
  /**
   * Preferred language of the Klarna authorization page that the customer is redirected to.
   * Can be one of `de-AT`, `en-AT`, `nl-BE`, `fr-BE`, `en-BE`, `de-DE`, `en-DE`, `da-DK`, `en-DK`, `es-ES`, `en-ES`, `fi-FI`, `sv-FI`, `en-FI`, `en-GB`, `en-IE`, `it-IT`, `en-IT`, `nl-NL`, `en-NL`, `nb-NO`, `en-NO`, `sv-SE`, `en-SE`, `en-US`, `es-US`, `fr-FR`, `en-FR`, `cs-CZ`, `en-CZ`, `el-GR`, `en-GR`, `en-AU`, `en-NZ`, `en-CA`, `fr-CA`, `pl-PL`, `en-PL`, `pt-PT`, `en-PT`, `de-CH`, `fr-CH`, `it-CH`, or `en-CH`
   */
  preferred_locale?: (string | null)
}
export interface PaymentMethodDetailsKonbini {
  /**
   * If the payment succeeded, this contains the details of the convenience store where the payment was completed.
   */
  store?: (PaymentMethodDetailsKonbiniStore | null)
}
export interface PaymentMethodDetailsKonbiniStore {
  /**
   * The name of the convenience store chain where the payment was completed.
   */
  chain?: ("familymart" | "lawson" | "ministop" | "seicomart" | null)
}
export interface PaymentMethodDetailsLink {

}
export interface PaymentMethodDetailsMultibanco {
  /**
   * Entity number associated with this Multibanco payment.
   */
  entity?: (string | null)
  /**
   * Reference number associated with this Multibanco payment.
   */
  reference?: (string | null)
}
export interface PaymentMethodDetailsOxxo {
  /**
   * OXXO reference number
   */
  number?: (string | null)
}
export interface PaymentMethodDetailsP24 {
  /**
   * The customer's bank. Can be one of `ing`, `citi_handlowy`, `tmobile_usbugi_bankowe`, `plus_bank`, `etransfer_pocztowy24`, `banki_spbdzielcze`, `bank_nowy_bfg_sa`, `getin_bank`, `blik`, `noble_pay`, `ideabank`, `envelobank`, `santander_przelew24`, `nest_przelew`, `mbank_mtransfer`, `inteligo`, `pbac_z_ipko`, `bnp_paribas`, `credit_agricole`, `toyota_bank`, `bank_pekao_sa`, `volkswagen_bank`, `bank_millennium`, `alior_bank`, or `boz`.
   */
  bank?: ("alior_bank" | "bank_millennium" | "bank_nowy_bfg_sa" | "bank_pekao_sa" | "banki_spbdzielcze" | "blik" | "bnp_paribas" | "boz" | "citi_handlowy" | "credit_agricole" | "envelobank" | "etransfer_pocztowy24" | "getin_bank" | "ideabank" | "ing" | "inteligo" | "mbank_mtransfer" | "nest_przelew" | "noble_pay" | "pbac_z_ipko" | "plus_bank" | "santander_przelew24" | "tmobile_usbugi_bankowe" | "toyota_bank" | "volkswagen_bank" | null)
  /**
   * Unique reference for this Przelewy24 payment.
   */
  reference?: (string | null)
  /**
   * Owner's verified full name. Values are verified or provided by Przelewy24 directly
   * (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   * Przelewy24 rarely provides this information so the attribute is usually empty.
   */
  verified_name?: (string | null)
}
export interface PaymentMethodDetailsPaynow {
  /**
   * Reference number associated with this PayNow payment
   */
  reference?: (string | null)
}
export interface PaymentMethodDetailsPix {
  /**
   * Unique transaction id generated by BCB
   */
  bank_transaction_id?: (string | null)
}
export interface PaymentMethodDetailsPromptpay {
  /**
   * Bill reference generated by PromptPay
   */
  reference?: (string | null)
}
export interface PaymentMethodDetailsSepaDebit {
  /**
   * Bank code of bank associated with the bank account.
   */
  bank_code?: (string | null)
  /**
   * Branch code of bank associated with the bank account.
   */
  branch_code?: (string | null)
  /**
   * Two-letter ISO code representing the country the bank account is located in.
   */
  country?: (string | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Last four characters of the IBAN.
   */
  last4?: (string | null)
  /**
   * ID of the mandate used to make this payment.
   */
  mandate?: (string | null)
}
export interface PaymentMethodDetailsSofort {
  /**
   * Bank code of bank associated with the bank account.
   */
  bank_code?: (string | null)
  /**
   * Name of the bank associated with the bank account.
   */
  bank_name?: (string | null)
  /**
   * Bank Identifier Code of the bank associated with the bank account.
   */
  bic?: (string | null)
  /**
   * Two-letter ISO code representing the country the bank account is located in.
   */
  country?: (string | null)
  /**
   * The ID of the SEPA Direct Debit PaymentMethod which was generated by this Charge.
   */
  generated_sepa_debit?: (string | PaymentMethod | null)
  /**
   * The mandate for the SEPA Direct Debit PaymentMethod which was generated by this Charge.
   */
  generated_sepa_debit_mandate?: (string | Mandate | null)
  /**
   * Last four characters of the IBAN.
   */
  iban_last4?: (string | null)
  /**
   * Preferred language of the SOFORT authorization page that the customer is redirected to.
   * Can be one of `de`, `en`, `es`, `fr`, `it`, `nl`, or `pl`
   */
  preferred_language?: ("de" | "en" | "es" | "fr" | "it" | "nl" | "pl" | null)
  /**
   * Owner's verified full name. Values are verified or provided by SOFORT directly
   * (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  verified_name?: (string | null)
}
export interface PaymentMethodDetailsStripeAccount {

}
export interface PaymentMethodDetailsUsBankAccount {
  /**
   * Account holder type: individual or company.
   */
  account_holder_type?: ("company" | "individual" | null)
  /**
   * Account type: checkings or savings. Defaults to checking if omitted.
   */
  account_type?: ("checking" | "savings" | null)
  /**
   * Name of the bank associated with the bank account.
   */
  bank_name?: (string | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Last four digits of the bank account number.
   */
  last4?: (string | null)
  /**
   * Routing number of the bank account.
   */
  routing_number?: (string | null)
}
export interface PaymentMethodDetailsWechat {

}
export interface PaymentMethodDetailsWechatPay {
  /**
   * Uniquely identifies this particular WeChat Pay account. You can use this attribute to check whether two WeChat accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Transaction ID of this particular WeChat Pay transaction.
   */
  transaction_id?: (string | null)
}
/**
 * Options to configure Radar. See [Radar Session](https://stripe.com/docs/radar/radar-session) for more information.
 */
export interface RadarRadarOptions {
  /**
   * A [Radar Session](https://stripe.com/docs/radar/radar-session) is a snapshot of the browser metadata and device details that help Radar make more accurate predictions on your payments.
   */
  session?: string
}
/**
 * Reviews can be used to supplement automated fraud detection with human expertise.
 * 
 * Learn more about [Radar](/radar) and reviewing payments
 * [here](https://stripe.com/docs/radar/reviews).
 */
export interface RadarReview {
  /**
   * The ZIP or postal code of the card used, if applicable.
   */
  billing_zip?: (string | null)
  /**
   * The charge associated with this review.
   */
  charge?: (string | Charge | null)
  /**
   * The reason the review was closed, or null if it has not yet been closed. One of `approved`, `refunded`, `refunded_as_fraud`, `disputed`, or `redacted`.
   */
  closed_reason?: ("approved" | "disputed" | "redacted" | "refunded" | "refunded_as_fraud" | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The IP address where the payment originated.
   */
  ip_address?: (string | null)
  /**
   * Information related to the location of the payment. Note that this information is an approximation and attempts to locate the nearest population center - it should not be used to determine a specific address.
   */
  ip_address_location?: (RadarReviewResourceLocation | null)
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "review"
  /**
   * If `true`, the review needs action.
   */
  open: boolean
  /**
   * The reason the review was opened. One of `rule` or `manual`.
   */
  opened_reason: ("manual" | "rule")
  /**
   * The PaymentIntent ID associated with this review, if one exists.
   */
  payment_intent?: (string | PaymentIntent)
  /**
   * The reason the review is currently open or closed. One of `rule`, `manual`, `approved`, `refunded`, `refunded_as_fraud`, `disputed`, or `redacted`.
   */
  reason: string
  /**
   * Information related to the browsing session of the user who initiated the payment.
   */
  session?: (RadarReviewResourceSession | null)
}
export interface RadarReviewResourceLocation {
  /**
   * The city where the payment originated.
   */
  city?: (string | null)
  /**
   * Two-letter ISO code representing the country where the payment originated.
   */
  country?: (string | null)
  /**
   * The geographic latitude where the payment originated.
   */
  latitude?: (number | null)
  /**
   * The geographic longitude where the payment originated.
   */
  longitude?: (number | null)
  /**
   * The state/county/province/region where the payment originated.
   */
  region?: (string | null)
}
export interface RadarReviewResourceSession {
  /**
   * The browser used in this browser session (e.g., `Chrome`).
   */
  browser?: (string | null)
  /**
   * Information about the device used for the browser session (e.g., `Samsung SM-G930T`).
   */
  device?: (string | null)
  /**
   * The platform for the browser session (e.g., `Macintosh`).
   */
  platform?: (string | null)
  /**
   * The version for the browser session (e.g., `61.0.3163.100`).
   */
  version?: (string | null)
}
export interface ChargeTransferData {
  /**
   * The amount transferred to the destination account, if specified. By default, the entire charge amount is transferred to the destination account.
   */
  amount?: (number | null)
  /**
   * ID of an existing, connected Stripe account to transfer funds to if `transfer_data` was specified in the charge request.
   */
  destination: (string | Account)
}
export interface InvoicesResourceInvoiceTaxID {
  /**
   * The type of the tax ID, one of `eu_vat`, `br_cnpj`, `br_cpf`, `eu_oss_vat`, `gb_vat`, `nz_gst`, `au_abn`, `au_arn`, `in_gst`, `no_vat`, `za_vat`, `ch_vat`, `mx_rfc`, `sg_uen`, `ru_inn`, `ru_kpp`, `ca_bn`, `hk_br`, `es_cif`, `tw_vat`, `th_vat`, `jp_cn`, `jp_rn`, `jp_trn`, `li_uid`, `my_itn`, `us_ein`, `kr_brn`, `ca_qst`, `ca_gst_hst`, `ca_pst_bc`, `ca_pst_mb`, `ca_pst_sk`, `my_sst`, `sg_gst`, `ae_trn`, `cl_tin`, `sa_vat`, `id_npwp`, `my_frp`, `il_vat`, `ge_vat`, `ua_vat`, `is_vat`, `bg_uic`, `hu_tin`, `si_tin`, `ke_pin`, `tr_tin`, `eg_tin`, `ph_tin`, or `unknown`
   */
  type: ("ae_trn" | "au_abn" | "au_arn" | "bg_uic" | "br_cnpj" | "br_cpf" | "ca_bn" | "ca_gst_hst" | "ca_pst_bc" | "ca_pst_mb" | "ca_pst_sk" | "ca_qst" | "ch_vat" | "cl_tin" | "eg_tin" | "es_cif" | "eu_oss_vat" | "eu_vat" | "gb_vat" | "ge_vat" | "hk_br" | "hu_tin" | "id_npwp" | "il_vat" | "in_gst" | "is_vat" | "jp_cn" | "jp_rn" | "jp_trn" | "ke_pin" | "kr_brn" | "li_uid" | "mx_rfc" | "my_frp" | "my_itn" | "my_sst" | "no_vat" | "nz_gst" | "ph_tin" | "ru_inn" | "ru_kpp" | "sa_vat" | "sg_gst" | "sg_uen" | "si_tin" | "th_vat" | "tr_tin" | "tw_vat" | "ua_vat" | "unknown" | "us_ein" | "za_vat")
  /**
   * The value of the tax ID.
   */
  value?: (string | null)
}
/**
 * Tax rates can be applied to [invoices](https://stripe.com/docs/billing/invoices/tax-rates), [subscriptions](https://stripe.com/docs/billing/subscriptions/taxes) and [Checkout Sessions](https://stripe.com/docs/payments/checkout/set-up-a-subscription#tax-rates) to collect tax.
 * 
 * Related guide: [Tax Rates](https://stripe.com/docs/billing/taxes/tax-rates).
 */
export interface TaxRate {
  /**
   * Defaults to `true`. When set to `false`, this tax rate cannot be used with new applications or Checkout Sessions, but will still work for subscriptions and invoices that already have it set.
   */
  active: boolean
  /**
   * Two-letter country code ([ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2)).
   */
  country?: (string | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * An arbitrary string attached to the tax rate for your internal use only. It will not be visible to your customers.
   */
  description?: (string | null)
  /**
   * The display name of the tax rates as it will appear to your customer on their receipt email, PDF, and the hosted invoice page.
   */
  display_name: string
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * This specifies if the tax rate is inclusive or exclusive.
   */
  inclusive: boolean
  /**
   * The jurisdiction for the tax rate. You can use this label field for tax reporting purposes. It also appears on your customer’s invoice.
   */
  jurisdiction?: (string | null)
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "tax_rate"
  /**
   * This represents the tax rate percent out of 100.
   */
  percentage: number
  /**
   * [ISO 3166-2 subdivision code](https://en.wikipedia.org/wiki/ISO_3166-2:US), without country prefix. For example, "NY" for New York, United States.
   */
  state?: (string | null)
  /**
   * The high-level tax type, such as `vat` or `sales_tax`.
   */
  tax_type?: ("gst" | "hst" | "igst" | "jct" | "pst" | "qst" | "rst" | "sales_tax" | "vat" | null)
}
export interface DeletedDiscount {
  /**
   * The Checkout session that this coupon is applied to, if it is applied to a particular session in payment mode. Will not be present for subscription mode.
   */
  checkout_session?: (string | null)
  coupon: Coupon
  /**
   * The ID of the customer associated with this discount.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * The ID of the discount object. Discounts cannot be fetched by ID. Use `expand[]=discounts` in API calls to expand discount IDs in an array.
   */
  id: string
  /**
   * The invoice that the discount's coupon was applied to, if it was applied directly to a particular invoice.
   */
  invoice?: (string | null)
  /**
   * The invoice item `id` (or invoice line item `id` for invoice line items of type='subscription') that the discount's coupon was applied to, if it was applied directly to a particular invoice item or invoice line item.
   */
  invoice_item?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "discount"
  /**
   * The promotion code applied to create this discount.
   */
  promotion_code?: (string | PromotionCode | null)
  /**
   * Date that the coupon was applied.
   */
  start: number
  /**
   * The subscription that this coupon is applied to, if it is applied to a particular subscription.
   */
  subscription?: (string | null)
}
export interface InvoicesFromInvoice {
  /**
   * The relation between this invoice and the cloned invoice
   */
  action: string
  /**
   * The invoice that was cloned.
   */
  invoice: (string | Invoice)
}
/**
 * The individual line items that make up the invoice. `lines` is sorted as follows: (1) pending invoice items (including prorations) in reverse chronological order, (2) subscription items in reverse chronological order, and (3) invoice items added after invoice creation in chronological order.
 */
export interface InvoiceLinesList {
  /**
   * Details about each object.
   */
  data: InvoiceLineItem[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
export interface InvoiceLineItem {
  /**
   * The amount, in %s.
   */
  amount: number
  /**
   * The integer amount in %s representing the amount for this line item, excluding all tax and discounts.
   */
  amount_excluding_tax?: (number | null)
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * The amount of discount calculated per discount for this line item.
   */
  discount_amounts?: (DiscountsResourceDiscountAmount[] | null)
  /**
   * If true, discounts will apply to this line item. Always false for prorations.
   */
  discountable: boolean
  /**
   * The discounts applied to the invoice line item. Line item discounts are applied before invoice discounts. Use `expand[]=discounts` to expand each discount.
   */
  discounts?: ((string | Discount)[] | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The ID of the [invoice item](https://stripe.com/docs/api/invoiceitems) associated with this line item if any.
   */
  invoice_item?: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format. Note that for line items with `type=subscription` this will reflect the metadata of the subscription that caused the line item to be created.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "line_item"
  period: InvoiceLineItemPeriod
  /**
   * The price of the line item.
   */
  price?: (Price | null)
  /**
   * Whether this is a proration.
   */
  proration: boolean
  /**
   * Additional details for proration line items
   */
  proration_details?: (InvoicesLineItemsProrationDetails | null)
  /**
   * The quantity of the subscription, if the line item is a subscription or a proration.
   */
  quantity?: (number | null)
  /**
   * The subscription that the invoice item pertains to, if any.
   */
  subscription?: (string | null)
  /**
   * The subscription item that generated this line item. Left empty if the line item is not an explicit result of a subscription.
   */
  subscription_item?: string
  /**
   * The amount of tax calculated per tax rate for this line item
   */
  tax_amounts?: InvoiceTaxAmount[]
  /**
   * The tax rates which apply to the line item.
   */
  tax_rates?: TaxRate[]
  /**
   * A string identifying the type of the source of this line item, either an `invoiceitem` or a `subscription`.
   */
  type: ("invoiceitem" | "subscription")
  /**
   * The amount in %s representing the unit amount for this line item, excluding all tax and discounts.
   */
  unit_amount_excluding_tax?: (string | null)
}
export interface DiscountsResourceDiscountAmount {
  /**
   * The amount, in %s, of the discount.
   */
  amount: number
  /**
   * The discount that was applied to get this discount amount.
   */
  discount: (string | Discount | DeletedDiscount)
}
export interface InvoiceLineItemPeriod {
  /**
   * The end of the period, which must be greater than or equal to the start. This value is inclusive.
   */
  end: number
  /**
   * The start of the period. This value is inclusive.
   */
  start: number
}
/**
 * Prices define the unit cost, currency, and (optional) billing cycle for both recurring and one-time purchases of products.
 * [Products](https://stripe.com/docs/api#products) help you track inventory or provisioning, and prices help you track payment terms. Different physical goods or levels of service should be represented by products, and pricing options should be represented by prices. This approach lets you change prices without having to change your provisioning scheme.
 * 
 * For example, you might have a single "gold" product that has prices for $10/month, $100/year, and €9 once.
 * 
 * Related guides: [Set up a subscription](https://stripe.com/docs/billing/subscriptions/set-up-subscription), [create an invoice](https://stripe.com/docs/billing/invoices/create), and more about [products and prices](https://stripe.com/docs/products-prices/overview).
 */
export interface Price {
  /**
   * Whether the price can be used for new purchases.
   */
  active: boolean
  /**
   * Describes how to compute the price per period. Either `per_unit` or `tiered`. `per_unit` indicates that the fixed amount (specified in `unit_amount` or `unit_amount_decimal`) will be charged per unit in `quantity` (for prices with `usage_type=licensed`), or per unit of total usage (for prices with `usage_type=metered`). `tiered` indicates that the unit pricing will be computed using a tiering strategy as defined using the `tiers` and `tiers_mode` attributes.
   */
  billing_scheme: ("per_unit" | "tiered")
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * Prices defined in each available currency option. Each key must be a three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html) and a [supported currency](https://stripe.com/docs/currencies).
   */
  currency_options?: {
    [k: string]: CurrencyOption
  }
  /**
   * When set, provides configuration for the amount to be adjusted by the customer during Checkout Sessions and Payment Links.
   */
  custom_unit_amount?: (CustomUnitAmount | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * A lookup key used to retrieve prices dynamically from a static string. This may be up to 200 characters.
   */
  lookup_key?: (string | null)
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * A brief description of the price, hidden from customers.
   */
  nickname?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "price"
  /**
   * The ID of the product this price is associated with.
   */
  product: (string | Product | DeletedProduct)
  /**
   * The recurring components of a price such as `interval` and `usage_type`.
   */
  recurring?: (Recurring | null)
  /**
   * Specifies whether the price is considered inclusive of taxes or exclusive of taxes. One of `inclusive`, `exclusive`, or `unspecified`. Once specified as either `inclusive` or `exclusive`, it cannot be changed.
   */
  tax_behavior?: ("exclusive" | "inclusive" | "unspecified" | null)
  /**
   * Each element represents a pricing tier. This parameter requires `billing_scheme` to be set to `tiered`. See also the documentation for `billing_scheme`.
   */
  tiers?: PriceTier[]
  /**
   * Defines if the tiering price should be `graduated` or `volume` based. In `volume`-based tiering, the maximum quantity within a period determines the per unit price. In `graduated` tiering, pricing can change as the quantity grows.
   */
  tiers_mode?: ("graduated" | "volume" | null)
  /**
   * Apply a transformation to the reported usage or set quantity before computing the amount billed. Cannot be combined with `tiers`.
   */
  transform_quantity?: (TransformQuantity | null)
  /**
   * One of `one_time` or `recurring` depending on whether the price is for a one-time purchase or a recurring (subscription) purchase.
   */
  type: ("one_time" | "recurring")
  /**
   * The unit amount in %s to be charged, represented as a whole integer if possible. Only set if `billing_scheme=per_unit`.
   */
  unit_amount?: (number | null)
  /**
   * The unit amount in %s to be charged, represented as a decimal string with at most 12 decimal places. Only set if `billing_scheme=per_unit`.
   */
  unit_amount_decimal?: (string | null)
}
export interface CurrencyOption {
  /**
   * When set, provides configuration for the amount to be adjusted by the customer during Checkout Sessions and Payment Links.
   */
  custom_unit_amount?: (CustomUnitAmount | null)
  /**
   * Specifies whether the price is considered inclusive of taxes or exclusive of taxes. One of `inclusive`, `exclusive`, or `unspecified`. Once specified as either `inclusive` or `exclusive`, it cannot be changed.
   */
  tax_behavior?: ("exclusive" | "inclusive" | "unspecified" | null)
  /**
   * Each element represents a pricing tier. This parameter requires `billing_scheme` to be set to `tiered`. See also the documentation for `billing_scheme`.
   */
  tiers?: PriceTier[]
  /**
   * The unit amount in %s to be charged, represented as a whole integer if possible. Only set if `billing_scheme=per_unit`.
   */
  unit_amount?: (number | null)
  /**
   * The unit amount in %s to be charged, represented as a decimal string with at most 12 decimal places. Only set if `billing_scheme=per_unit`.
   */
  unit_amount_decimal?: (string | null)
}
export interface CustomUnitAmount {
  /**
   * The maximum unit amount the customer can specify for this item.
   */
  maximum?: (number | null)
  /**
   * The minimum unit amount the customer can specify for this item. Must be at least the minimum charge amount.
   */
  minimum?: (number | null)
  /**
   * The starting unit amount which can be updated by the customer.
   */
  preset?: (number | null)
}
export interface PriceTier {
  /**
   * Price for the entire tier.
   */
  flat_amount?: (number | null)
  /**
   * Same as `flat_amount`, but contains a decimal value with at most 12 decimal places.
   */
  flat_amount_decimal?: (string | null)
  /**
   * Per unit price for units relevant to the tier.
   */
  unit_amount?: (number | null)
  /**
   * Same as `unit_amount`, but contains a decimal value with at most 12 decimal places.
   */
  unit_amount_decimal?: (string | null)
  /**
   * Up to and including to this quantity will be contained in the tier.
   */
  up_to?: (number | null)
}
/**
 * Products describe the specific goods or services you offer to your customers.
 * For example, you might offer a Standard and Premium version of your goods or service; each version would be a separate Product.
 * They can be used in conjunction with [Prices](https://stripe.com/docs/api#prices) to configure pricing in Payment Links, Checkout, and Subscriptions.
 * 
 * Related guides: [Set up a subscription](https://stripe.com/docs/billing/subscriptions/set-up-subscription),
 * [share a Payment Link](https://stripe.com/docs/payments/payment-links/overview),
 * [accept payments with Checkout](https://stripe.com/docs/payments/accept-a-payment#create-product-prices-upfront),
 * and more about [Products and Prices](https://stripe.com/docs/products-prices/overview)
 */
export interface Product {
  /**
   * Whether the product is currently available for purchase.
   */
  active: boolean
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * The ID of the [Price](https://stripe.com/docs/api/prices) object that is the default price for this product.
   */
  default_price?: (string | Price | null)
  /**
   * The product's description, meant to be displayable to the customer. Use this field to optionally store a long form explanation of the product being sold for your own rendering purposes.
   */
  description?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * A list of up to 8 URLs of images for this product, meant to be displayable to the customer.
   */
  images: string[]
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * The product's name, meant to be displayable to the customer.
   */
  name: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "product"
  /**
   * The dimensions of this product for shipping purposes.
   */
  package_dimensions?: (PackageDimensions | null)
  /**
   * Whether this product is shipped (i.e., physical goods).
   */
  shippable?: (boolean | null)
  /**
   * Extra information about a product which will appear on your customer's credit card statement. In the case that multiple products are billed at once, the first statement descriptor will be used.
   */
  statement_descriptor?: (string | null)
  /**
   * A [tax code](https://stripe.com/docs/tax/tax-categories) ID.
   */
  tax_code?: (string | TaxProductResourceTaxCode | null)
  /**
   * A label that represents units of this product. When set, this will be included in customers' receipts, invoices, Checkout, and the customer portal.
   */
  unit_label?: (string | null)
  /**
   * Time at which the object was last updated. Measured in seconds since the Unix epoch.
   */
  updated: number
  /**
   * A URL of a publicly-accessible webpage for this product.
   */
  url?: (string | null)
}
export interface PackageDimensions {
  /**
   * Height, in inches.
   */
  height: number
  /**
   * Length, in inches.
   */
  length: number
  /**
   * Weight, in ounces.
   */
  weight: number
  /**
   * Width, in inches.
   */
  width: number
}
/**
 * [Tax codes](https://stripe.com/docs/tax/tax-categories) classify goods and services for tax purposes.
 */
export interface TaxProductResourceTaxCode {
  /**
   * A detailed description of which types of products the tax code represents.
   */
  description: string
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * A short name for the tax code.
   */
  name: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "tax_code"
}
export interface DeletedProduct {
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "product"
}
export interface Recurring {
  /**
   * Specifies a usage aggregation strategy for prices of `usage_type=metered`. Allowed values are `sum` for summing up all usage during a period, `last_during_period` for using the last usage record reported within a period, `last_ever` for using the last usage record ever (across period bounds) or `max` which uses the usage record with the maximum reported usage during a period. Defaults to `sum`.
   */
  aggregate_usage?: ("last_during_period" | "last_ever" | "max" | "sum" | null)
  /**
   * The frequency at which a subscription is billed. One of `day`, `week`, `month` or `year`.
   */
  interval: ("day" | "month" | "week" | "year")
  /**
   * The number of intervals (specified in the `interval` attribute) between subscription billings. For example, `interval=month` and `interval_count=3` bills every 3 months.
   */
  interval_count: number
  /**
   * Configures how the quantity per period should be determined. Can be either `metered` or `licensed`. `licensed` automatically bills the `quantity` set when adding it to a subscription. `metered` aggregates the total usage based on usage records. Defaults to `licensed`.
   */
  usage_type: ("licensed" | "metered")
}
export interface TransformQuantity {
  /**
   * Divide usage by this number.
   */
  divide_by: number
  /**
   * After division, either round the result `up` or `down`.
   */
  round: ("down" | "up")
}
export interface InvoicesLineItemsProrationDetails {
  /**
   * For a credit proration `line_item`, the original debit line_items to which the credit proration applies.
   */
  credited_items?: (InvoicesLineItemsCreditedItems | null)
}
export interface InvoicesLineItemsCreditedItems {
  /**
   * Invoice containing the credited invoice line items
   */
  invoice: string
  /**
   * Credited invoice line items
   */
  invoice_line_items: string[]
}
export interface InvoiceTaxAmount {
  /**
   * The amount, in %s, of the tax.
   */
  amount: number
  /**
   * Whether this tax amount is inclusive or exclusive.
   */
  inclusive: boolean
  /**
   * The tax rate that was applied to get this tax amount.
   */
  tax_rate: (string | TaxRate)
}
export interface InvoicesPaymentSettings {
  /**
   * ID of the mandate to be used for this invoice. It must correspond to the payment method used to pay the invoice, including the invoice's default_payment_method or default_source, if set.
   */
  default_mandate?: (string | null)
  /**
   * Payment-method-specific configuration to provide to the invoice’s PaymentIntent.
   */
  payment_method_options?: (InvoicesPaymentMethodOptions | null)
  /**
   * The list of payment method types (e.g. card) to provide to the invoice’s PaymentIntent. If not set, Stripe attempts to automatically determine the types to use by looking at the invoice’s default payment method, the subscription’s default payment method, the customer’s default payment method, and your [invoice template settings](https://dashboard.stripe.com/settings/billing/invoice).
   */
  payment_method_types?: (("ach_credit_transfer" | "ach_debit" | "acss_debit" | "au_becs_debit" | "bacs_debit" | "bancontact" | "boleto" | "card" | "customer_balance" | "fpx" | "giropay" | "grabpay" | "ideal" | "konbini" | "link" | "paynow" | "promptpay" | "sepa_debit" | "sofort" | "us_bank_account" | "wechat_pay")[] | null)
}
export interface InvoicesPaymentMethodOptions {
  /**
   * If paying by `acss_debit`, this sub-hash contains details about the Canadian pre-authorized debit payment method options to pass to the invoice’s PaymentIntent.
   */
  acss_debit?: (InvoicePaymentMethodOptionsAcssDebit | null)
  /**
   * If paying by `bancontact`, this sub-hash contains details about the Bancontact payment method options to pass to the invoice’s PaymentIntent.
   */
  bancontact?: (InvoicePaymentMethodOptionsBancontact | null)
  /**
   * If paying by `card`, this sub-hash contains details about the Card payment method options to pass to the invoice’s PaymentIntent.
   */
  card?: (InvoicePaymentMethodOptionsCard | null)
  /**
   * If paying by `customer_balance`, this sub-hash contains details about the Bank transfer payment method options to pass to the invoice’s PaymentIntent.
   */
  customer_balance?: (InvoicePaymentMethodOptionsCustomerBalance | null)
  /**
   * If paying by `konbini`, this sub-hash contains details about the Konbini payment method options to pass to the invoice’s PaymentIntent.
   */
  konbini?: (InvoicePaymentMethodOptionsKonbini | null)
  /**
   * If paying by `us_bank_account`, this sub-hash contains details about the ACH direct debit payment method options to pass to the invoice’s PaymentIntent.
   */
  us_bank_account?: (InvoicePaymentMethodOptionsUsBankAccount | null)
}
export interface InvoicePaymentMethodOptionsAcssDebit {
  mandate_options?: InvoicePaymentMethodOptionsAcssDebitMandateOptions
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant" | "microdeposits")
}
export interface InvoicePaymentMethodOptionsAcssDebitMandateOptions {
  /**
   * Transaction type of the mandate.
   */
  transaction_type?: ("business" | "personal" | null)
}
export interface InvoicePaymentMethodOptionsBancontact {
  /**
   * Preferred language of the Bancontact authorization page that the customer is redirected to.
   */
  preferred_language: ("de" | "en" | "fr" | "nl")
}
export interface InvoicePaymentMethodOptionsCard {
  installments?: InvoiceInstallmentsCard
  /**
   * We strongly recommend that you rely on our SCA Engine to automatically prompt your customers for authentication based on risk level and [other requirements](https://stripe.com/docs/strong-customer-authentication). However, if you wish to request 3D Secure based on logic from your own fraud engine, provide this option. Read our guide on [manually requesting 3D Secure](https://stripe.com/docs/payments/3d-secure#manual-three-ds) for more information on how this configuration interacts with Radar and our SCA Engine.
   */
  request_three_d_secure?: ("any" | "automatic" | null)
}
export interface InvoiceInstallmentsCard {
  /**
   * Whether Installments are enabled for this Invoice.
   */
  enabled?: (boolean | null)
}
export interface InvoicePaymentMethodOptionsCustomerBalance {
  bank_transfer?: InvoicePaymentMethodOptionsCustomerBalanceBankTransfer
  /**
   * The funding method type to be used when there are not enough funds in the customer balance. Permitted values include: `bank_transfer`.
   */
  funding_type?: ("bank_transfer" | null)
}
export interface InvoicePaymentMethodOptionsCustomerBalanceBankTransfer {
  eu_bank_transfer?: InvoicePaymentMethodOptionsCustomerBalanceBankTransferEuBankTransfer
  /**
   * The bank transfer type that can be used for funding. Permitted values include: `eu_bank_transfer`, `gb_bank_transfer`, `jp_bank_transfer`, or `mx_bank_transfer`.
   */
  type?: (string | null)
}
export interface InvoicePaymentMethodOptionsCustomerBalanceBankTransferEuBankTransfer {
  /**
   * The desired country code of the bank account information. Permitted values include: `BE`, `DE`, `ES`, `FR`, `IE`, or `NL`.
   */
  country: ("BE" | "DE" | "ES" | "FR" | "IE" | "NL")
}
export interface InvoicePaymentMethodOptionsKonbini {

}
export interface InvoicePaymentMethodOptionsUsBankAccount {
  financial_connections?: InvoicePaymentMethodOptionsUsBankAccountLinkedAccountOptions
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant" | "microdeposits")
}
export interface InvoicePaymentMethodOptionsUsBankAccountLinkedAccountOptions {
  /**
   * The list of permissions to request. The `payment_method` permission must be included.
   */
  permissions?: ("balances" | "payment_method" | "transactions")[]
}
/**
 * A Quote is a way to model prices that you'd like to provide to a customer.
 * Once accepted, it will automatically create an invoice, subscription or subscription schedule.
 */
export interface Quote {
  /**
   * Total before any discounts or taxes are applied.
   */
  amount_subtotal: number
  /**
   * Total after discounts and taxes are applied.
   */
  amount_total: number
  /**
   * ID of the Connect Application that created the quote.
   */
  application?: (string | Application | DeletedApplication | null)
  /**
   * The amount of the application fee (if any) that will be requested to be applied to the payment and transferred to the application owner's Stripe account. Only applicable if there are no line items with recurring prices on the quote.
   */
  application_fee_amount?: (number | null)
  /**
   * A non-negative decimal between 0 and 100, with at most two decimal places. This represents the percentage of the subscription invoice subtotal that will be transferred to the application owner's Stripe account. Only applicable if there are line items with recurring prices on the quote.
   */
  application_fee_percent?: (number | null)
  automatic_tax: QuotesResourceAutomaticTax
  /**
   * Either `charge_automatically`, or `send_invoice`. When charging automatically, Stripe will attempt to pay invoices at the end of the subscription cycle or on finalization using the default payment method attached to the subscription or customer. When sending an invoice, Stripe will email your customer an invoice with payment instructions and mark the subscription as `active`. Defaults to `charge_automatically`.
   */
  collection_method: ("charge_automatically" | "send_invoice")
  computed: QuotesResourceComputed
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency?: (string | null)
  /**
   * The customer which this quote belongs to. A customer is required before finalizing the quote. Once specified, it cannot be changed.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * The tax rates applied to this quote.
   */
  default_tax_rates?: (string | TaxRate)[]
  /**
   * A description that will be displayed on the quote PDF.
   */
  description?: (string | null)
  /**
   * The discounts applied to this quote.
   */
  discounts: (string | Discount)[]
  /**
   * The date on which the quote will be canceled if in `open` or `draft` status. Measured in seconds since the Unix epoch.
   */
  expires_at: number
  /**
   * A footer that will be displayed on the quote PDF.
   */
  footer?: (string | null)
  /**
   * Details of the quote that was cloned. See the [cloning documentation](https://stripe.com/docs/quotes/clone) for more details.
   */
  from_quote?: (QuotesResourceFromQuote | null)
  /**
   * A header that will be displayed on the quote PDF.
   */
  header?: (string | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The invoice that was created from this quote.
   */
  invoice?: (string | Invoice | DeletedInvoice | null)
  /**
   * All invoices will be billed using the specified settings.
   */
  invoice_settings?: (InvoiceSettingQuoteSetting | null)
  line_items?: QuotesResourceListLineItems1
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * A unique number that identifies this particular quote. This number is assigned once the quote is [finalized](https://stripe.com/docs/quotes/overview#finalize).
   */
  number?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "quote"
  /**
   * The account on behalf of which to charge. See the [Connect documentation](https://support.stripe.com/questions/sending-invoices-on-behalf-of-connected-accounts) for details.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * The status of the quote.
   */
  status: ("accepted" | "canceled" | "draft" | "open")
  status_transitions: QuotesResourceStatusTransitions
  /**
   * The subscription that was created or updated from this quote.
   */
  subscription?: (string | Subscription | null)
  subscription_data: QuotesResourceSubscriptionDataSubscriptionData
  /**
   * The subscription schedule that was created or updated from this quote.
   */
  subscription_schedule?: (string | SubscriptionSchedule | null)
  /**
   * ID of the test clock this quote belongs to.
   */
  test_clock?: (string | TestClock | null)
  total_details: QuotesResourceTotalDetails
  /**
   * The account (if any) the payments will be attributed to for tax reporting, and where funds from each payment will be transferred to for each of the invoices.
   */
  transfer_data?: (QuotesResourceTransferData | null)
}
export interface QuotesResourceAutomaticTax {
  /**
   * Automatically calculate taxes
   */
  enabled: boolean
  /**
   * The status of the most recent automated tax calculation for this quote.
   */
  status?: ("complete" | "failed" | "requires_location_inputs" | null)
}
export interface QuotesResourceComputed {
  /**
   * The definitive totals and line items the customer will be charged on a recurring basis. Takes into account the line items with recurring prices and discounts with `duration=forever` coupons only. Defaults to `null` if no inputted line items with recurring prices.
   */
  recurring?: (QuotesResourceRecurring | null)
  upfront: QuotesResourceUpfront
}
export interface QuotesResourceRecurring {
  /**
   * Total before any discounts or taxes are applied.
   */
  amount_subtotal: number
  /**
   * Total after discounts and taxes are applied.
   */
  amount_total: number
  /**
   * The frequency at which a subscription is billed. One of `day`, `week`, `month` or `year`.
   */
  interval: ("day" | "month" | "week" | "year")
  /**
   * The number of intervals (specified in the `interval` attribute) between subscription billings. For example, `interval=month` and `interval_count=3` bills every 3 months.
   */
  interval_count: number
  total_details: QuotesResourceTotalDetails
}
export interface QuotesResourceTotalDetails {
  /**
   * This is the sum of all the discounts.
   */
  amount_discount: number
  /**
   * This is the sum of all the shipping amounts.
   */
  amount_shipping?: (number | null)
  /**
   * This is the sum of all the tax amounts.
   */
  amount_tax: number
  breakdown?: QuotesResourceTotalDetailsResourceBreakdown
}
export interface QuotesResourceTotalDetailsResourceBreakdown {
  /**
   * The aggregated discounts.
   */
  discounts: LineItemsDiscountAmount[]
  /**
   * The aggregated tax amounts by rate.
   */
  taxes: LineItemsTaxAmount[]
}
export interface LineItemsDiscountAmount {
  /**
   * The amount discounted.
   */
  amount: number
  discount: Discount
}
export interface LineItemsTaxAmount {
  /**
   * Amount of tax applied for this rate.
   */
  amount: number
  rate: TaxRate
}
export interface QuotesResourceUpfront {
  /**
   * Total before any discounts or taxes are applied.
   */
  amount_subtotal: number
  /**
   * Total after discounts and taxes are applied.
   */
  amount_total: number
  line_items?: QuotesResourceListLineItems
  total_details: QuotesResourceTotalDetails
}
/**
 * The line items that will appear on the next invoice after this quote is accepted. This does not include pending invoice items that exist on the customer but may still be included in the next invoice.
 */
export interface QuotesResourceListLineItems {
  /**
   * Details about each object.
   */
  data: LineItem[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
/**
 * A line item.
 */
export interface LineItem {
  /**
   * Total discount amount applied. If no discounts were applied, defaults to 0.
   */
  amount_discount: number
  /**
   * Total before any discounts or taxes are applied.
   */
  amount_subtotal: number
  /**
   * Total tax amount applied. If no tax was applied, defaults to 0.
   */
  amount_tax: number
  /**
   * Total after discounts and taxes.
   */
  amount_total: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users. Defaults to product name.
   */
  description: string
  /**
   * The discounts applied to the line item.
   */
  discounts?: LineItemsDiscountAmount[]
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "item"
  /**
   * The price used to generate the line item.
   */
  price?: (Price | null)
  /**
   * The quantity of products being purchased.
   */
  quantity?: (number | null)
  /**
   * The taxes applied to the line item.
   */
  taxes?: LineItemsTaxAmount[]
}
export interface QuotesResourceFromQuote {
  /**
   * Whether this quote is a revision of a different quote.
   */
  is_revision: boolean
  /**
   * The quote that was cloned.
   */
  quote: (string | Quote)
}
export interface DeletedInvoice {
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "invoice"
}
export interface InvoiceSettingQuoteSetting {
  /**
   * Number of days within which a customer must pay invoices generated by this quote. This value will be `null` for quotes where `collection_method=charge_automatically`.
   */
  days_until_due?: (number | null)
}
/**
 * A list of items the customer is being quoted for.
 */
export interface QuotesResourceListLineItems1 {
  /**
   * Details about each object.
   */
  data: LineItem[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
export interface QuotesResourceStatusTransitions {
  /**
   * The time that the quote was accepted. Measured in seconds since Unix epoch.
   */
  accepted_at?: (number | null)
  /**
   * The time that the quote was canceled. Measured in seconds since Unix epoch.
   */
  canceled_at?: (number | null)
  /**
   * The time that the quote was finalized. Measured in seconds since Unix epoch.
   */
  finalized_at?: (number | null)
}
/**
 * Subscriptions allow you to charge a customer on a recurring basis.
 * 
 * Related guide: [Creating Subscriptions](https://stripe.com/docs/billing/subscriptions/creating).
 */
export interface Subscription {
  /**
   * ID of the Connect Application that created the subscription.
   */
  application?: (string | Application | DeletedApplication | null)
  /**
   * A non-negative decimal between 0 and 100, with at most two decimal places. This represents the percentage of the subscription invoice subtotal that will be transferred to the application owner's Stripe account.
   */
  application_fee_percent?: (number | null)
  automatic_tax: SubscriptionAutomaticTax
  /**
   * Determines the date of the first full invoice, and, for plans with `month` or `year` intervals, the day of the month for subsequent invoices. The timestamp is in UTC format.
   */
  billing_cycle_anchor: number
  /**
   * Define thresholds at which an invoice will be sent, and the subscription advanced to a new billing period
   */
  billing_thresholds?: (SubscriptionBillingThresholds | null)
  /**
   * A date in the future at which the subscription will automatically get canceled
   */
  cancel_at?: (number | null)
  /**
   * If the subscription has been canceled with the `at_period_end` flag set to `true`, `cancel_at_period_end` on the subscription will be true. You can use this attribute to determine whether a subscription that has a status of active is scheduled to be canceled at the end of the current period.
   */
  cancel_at_period_end: boolean
  /**
   * If the subscription has been canceled, the date of that cancellation. If the subscription was canceled with `cancel_at_period_end`, `canceled_at` will reflect the time of the most recent update request, not the end of the subscription period when the subscription is automatically moved to a canceled state.
   */
  canceled_at?: (number | null)
  /**
   * Either `charge_automatically`, or `send_invoice`. When charging automatically, Stripe will attempt to pay this subscription at the end of the cycle using the default source attached to the customer. When sending an invoice, Stripe will email your customer an invoice with payment instructions and mark the subscription as `active`.
   */
  collection_method: ("charge_automatically" | "send_invoice")
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * End of the current period that the subscription has been invoiced for. At the end of this period, a new invoice will be created.
   */
  current_period_end: number
  /**
   * Start of the current period that the subscription has been invoiced for.
   */
  current_period_start: number
  /**
   * ID of the customer who owns the subscription.
   */
  customer: (string | Customer | DeletedCustomer)
  /**
   * Number of days a customer has to pay invoices generated by this subscription. This value will be `null` for subscriptions where `collection_method=charge_automatically`.
   */
  days_until_due?: (number | null)
  /**
   * ID of the default payment method for the subscription. It must belong to the customer associated with the subscription. This takes precedence over `default_source`. If neither are set, invoices will use the customer's [invoice_settings.default_payment_method](https://stripe.com/docs/api/customers/object#customer_object-invoice_settings-default_payment_method) or [default_source](https://stripe.com/docs/api/customers/object#customer_object-default_source).
   */
  default_payment_method?: (string | PaymentMethod | null)
  /**
   * ID of the default payment source for the subscription. It must belong to the customer associated with the subscription and be in a chargeable state. If `default_payment_method` is also set, `default_payment_method` will take precedence. If neither are set, invoices will use the customer's [invoice_settings.default_payment_method](https://stripe.com/docs/api/customers/object#customer_object-invoice_settings-default_payment_method) or [default_source](https://stripe.com/docs/api/customers/object#customer_object-default_source).
   */
  default_source?: (string | BankAccount | Card | Source | null)
  /**
   * The tax rates that will apply to any subscription item that does not have `tax_rates` set. Invoices created will have their `default_tax_rates` populated from the subscription.
   */
  default_tax_rates?: (TaxRate[] | null)
  /**
   * The subscription's description, meant to be displayable to the customer. Use this field to optionally store an explanation of the subscription for rendering in Stripe surfaces.
   */
  description?: (string | null)
  /**
   * Describes the current discount applied to this subscription, if there is one. When billing, a discount applied to a subscription overrides a discount applied on a customer-wide basis.
   */
  discount?: (Discount | null)
  /**
   * If the subscription has ended, the date the subscription ended.
   */
  ended_at?: (number | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  items: SubscriptionItemList
  /**
   * The most recent invoice this subscription has generated.
   */
  latest_invoice?: (string | Invoice | null)
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * Specifies the approximate timestamp on which any pending invoice items will be billed according to the schedule provided at `pending_invoice_item_interval`.
   */
  next_pending_invoice_item_invoice?: (number | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "subscription"
  /**
   * The account (if any) the charge was made on behalf of for charges associated with this subscription. See the Connect documentation for details.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * If specified, payment collection for this subscription will be paused.
   */
  pause_collection?: (SubscriptionsResourcePauseCollection | null)
  /**
   * Payment settings passed on to invoices created by the subscription.
   */
  payment_settings?: (SubscriptionsResourcePaymentSettings | null)
  /**
   * Specifies an interval for how often to bill for any pending invoice items. It is analogous to calling [Create an invoice](https://stripe.com/docs/api#create_invoice) for the given subscription at the specified interval.
   */
  pending_invoice_item_interval?: (SubscriptionPendingInvoiceItemInterval | null)
  /**
   * You can use this [SetupIntent](https://stripe.com/docs/api/setup_intents) to collect user authentication when creating a subscription without immediate payment or updating a subscription's payment method, allowing you to optimize for off-session payments. Learn more in the [SCA Migration Guide](https://stripe.com/docs/billing/migration/strong-customer-authentication#scenario-2).
   */
  pending_setup_intent?: (string | SetupIntent | null)
  /**
   * If specified, [pending updates](https://stripe.com/docs/billing/subscriptions/pending-updates) that will be applied to the subscription once the `latest_invoice` has been paid.
   */
  pending_update?: (SubscriptionsResourcePendingUpdate | null)
  /**
   * The schedule attached to the subscription
   */
  schedule?: (string | SubscriptionSchedule | null)
  /**
   * Date when the subscription was first created. The date might differ from the `created` date due to backdating.
   */
  start_date: number
  /**
   * Possible values are `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, or `unpaid`. 
   * 
   * For `collection_method=charge_automatically` a subscription moves into `incomplete` if the initial payment attempt fails. A subscription in this state can only have metadata and default_source updated. Once the first invoice is paid, the subscription moves into an `active` state. If the first invoice is not paid within 23 hours, the subscription transitions to `incomplete_expired`. This is a terminal state, the open invoice will be voided and no further invoices will be generated. 
   * 
   * A subscription that is currently in a trial period is `trialing` and moves to `active` when the trial period is over. 
   * 
   * If subscription `collection_method=charge_automatically` it becomes `past_due` when payment to renew it fails and `canceled` or `unpaid` (depending on your subscriptions settings) when Stripe has exhausted all payment retry attempts. 
   * 
   * If subscription `collection_method=send_invoice` it becomes `past_due` when its invoice is not paid by the due date, and `canceled` or `unpaid` if it is still not paid by an additional deadline after that. Note that when a subscription has a status of `unpaid`, no subsequent invoices will be attempted (invoices will be created, but then immediately automatically closed). After receiving updated payment information from a customer, you may choose to reopen and pay their closed invoices.
   */
  status: ("active" | "canceled" | "incomplete" | "incomplete_expired" | "past_due" | "paused" | "trialing" | "unpaid")
  /**
   * ID of the test clock this subscription belongs to.
   */
  test_clock?: (string | TestClock | null)
  /**
   * The account (if any) the subscription's payments will be attributed to for tax reporting, and where funds from each payment will be transferred to for each of the subscription's invoices.
   */
  transfer_data?: (SubscriptionTransferData | null)
  /**
   * If the subscription has a trial, the end of that trial.
   */
  trial_end?: (number | null)
  /**
   * Settings related to subscription trials.
   */
  trial_settings?: (SubscriptionsTrialsResourceTrialSettings | null)
  /**
   * If the subscription has a trial, the beginning of that trial.
   */
  trial_start?: (number | null)
  minItems?: 0
}
export interface SubscriptionAutomaticTax {
  /**
   * Whether Stripe automatically computes tax on this subscription.
   */
  enabled: boolean
}
export interface SubscriptionBillingThresholds {
  /**
   * Monetary threshold that triggers the subscription to create an invoice
   */
  amount_gte?: (number | null)
  /**
   * Indicates if the `billing_cycle_anchor` should be reset when a threshold is reached. If true, `billing_cycle_anchor` will be updated to the date/time the threshold was last reached; otherwise, the value will remain unchanged. This value may not be `true` if the subscription contains items with plans that have `aggregate_usage=last_ever`.
   */
  reset_billing_cycle_anchor?: (boolean | null)
}
/**
 * List of subscription items, each with an attached price.
 */
export interface SubscriptionItemList {
  /**
   * Details about each object.
   */
  data: SubscriptionItem[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
/**
 * Subscription items allow you to create customer subscriptions with more than
 * one plan, making it easy to represent complex billing relationships.
 */
export interface SubscriptionItem {
  /**
   * Define thresholds at which an invoice will be sent, and the related subscription advanced to a new billing period
   */
  billing_thresholds?: (SubscriptionItemBillingThresholds | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "subscription_item"
  price: Price
  /**
   * The [quantity](https://stripe.com/docs/subscriptions/quantities) of the plan to which the customer should be subscribed.
   */
  quantity?: number
  /**
   * The `subscription` this `subscription_item` belongs to.
   */
  subscription: string
  /**
   * The tax rates which apply to this `subscription_item`. When set, the `default_tax_rates` on the subscription do not apply to this `subscription_item`.
   */
  tax_rates?: (TaxRate[] | null)
}
export interface SubscriptionItemBillingThresholds {
  /**
   * Usage threshold that triggers the subscription to create an invoice
   */
  usage_gte?: (number | null)
}
/**
 * The Pause Collection settings determine how we will pause collection for this subscription and for how long the subscription
 * should be paused.
 */
export interface SubscriptionsResourcePauseCollection {
  /**
   * The payment collection behavior for this subscription while paused. One of `keep_as_draft`, `mark_uncollectible`, or `void`.
   */
  behavior: ("keep_as_draft" | "mark_uncollectible" | "void")
  /**
   * The time after which the subscription will resume collecting payments.
   */
  resumes_at?: (number | null)
}
export interface SubscriptionsResourcePaymentSettings {
  /**
   * Payment-method-specific configuration to provide to invoices created by the subscription.
   */
  payment_method_options?: (SubscriptionsResourcePaymentMethodOptions | null)
  /**
   * The list of payment method types to provide to every invoice created by the subscription. If not set, Stripe attempts to automatically determine the types to use by looking at the invoice’s default payment method, the subscription’s default payment method, the customer’s default payment method, and your [invoice template settings](https://dashboard.stripe.com/settings/billing/invoice).
   */
  payment_method_types?: (("ach_credit_transfer" | "ach_debit" | "acss_debit" | "au_becs_debit" | "bacs_debit" | "bancontact" | "boleto" | "card" | "customer_balance" | "fpx" | "giropay" | "grabpay" | "ideal" | "konbini" | "link" | "paynow" | "promptpay" | "sepa_debit" | "sofort" | "us_bank_account" | "wechat_pay")[] | null)
  /**
   * Either `off`, or `on_subscription`. With `on_subscription` Stripe updates `subscription.default_payment_method` when a subscription payment succeeds.
   */
  save_default_payment_method?: ("off" | "on_subscription" | null)
}
export interface SubscriptionsResourcePaymentMethodOptions {
  /**
   * This sub-hash contains details about the Canadian pre-authorized debit payment method options to pass to invoices created by the subscription.
   */
  acss_debit?: (InvoicePaymentMethodOptionsAcssDebit | null)
  /**
   * This sub-hash contains details about the Bancontact payment method options to pass to invoices created by the subscription.
   */
  bancontact?: (InvoicePaymentMethodOptionsBancontact | null)
  /**
   * This sub-hash contains details about the Card payment method options to pass to invoices created by the subscription.
   */
  card?: (SubscriptionPaymentMethodOptionsCard | null)
  /**
   * This sub-hash contains details about the Bank transfer payment method options to pass to invoices created by the subscription.
   */
  customer_balance?: (InvoicePaymentMethodOptionsCustomerBalance | null)
  /**
   * This sub-hash contains details about the Konbini payment method options to pass to invoices created by the subscription.
   */
  konbini?: (InvoicePaymentMethodOptionsKonbini | null)
  /**
   * This sub-hash contains details about the ACH direct debit payment method options to pass to invoices created by the subscription.
   */
  us_bank_account?: (InvoicePaymentMethodOptionsUsBankAccount | null)
}
export interface SubscriptionPaymentMethodOptionsCard {
  mandate_options?: InvoiceMandateOptionsCard
  /**
   * Selected network to process this Subscription on. Depends on the available networks of the card attached to the Subscription. Can be only set confirm-time.
   */
  network?: ("amex" | "cartes_bancaires" | "diners" | "discover" | "interac" | "jcb" | "mastercard" | "unionpay" | "unknown" | "visa" | null)
  /**
   * We strongly recommend that you rely on our SCA Engine to automatically prompt your customers for authentication based on risk level and [other requirements](https://stripe.com/docs/strong-customer-authentication). However, if you wish to request 3D Secure based on logic from your own fraud engine, provide this option. Read our guide on [manually requesting 3D Secure](https://stripe.com/docs/payments/3d-secure#manual-three-ds) for more information on how this configuration interacts with Radar and our SCA Engine.
   */
  request_three_d_secure?: ("any" | "automatic" | null)
}
export interface InvoiceMandateOptionsCard {
  /**
   * Amount to be charged for future payments.
   */
  amount?: (number | null)
  /**
   * One of `fixed` or `maximum`. If `fixed`, the `amount` param refers to the exact amount to be charged in future payments. If `maximum`, the amount charged can be up to the value passed for the `amount` param.
   */
  amount_type?: ("fixed" | "maximum" | null)
  /**
   * A description of the mandate or subscription that is meant to be displayed to the customer.
   */
  description?: (string | null)
}
export interface SubscriptionPendingInvoiceItemInterval {
  /**
   * Specifies invoicing frequency. Either `day`, `week`, `month` or `year`.
   */
  interval: ("day" | "month" | "week" | "year")
  /**
   * The number of intervals between invoices. For example, `interval=month` and `interval_count=3` bills every 3 months. Maximum of one year interval allowed (1 year, 12 months, or 52 weeks).
   */
  interval_count: number
}
/**
 * A SetupIntent guides you through the process of setting up and saving a customer's payment credentials for future payments.
 * For example, you could use a SetupIntent to set up and save your customer's card without immediately collecting a payment.
 * Later, you can use [PaymentIntents](https://stripe.com/docs/api#payment_intents) to drive the payment flow.
 * 
 * Create a SetupIntent as soon as you're ready to collect your customer's payment credentials.
 * Do not maintain long-lived, unconfirmed SetupIntents as they may no longer be valid.
 * The SetupIntent then transitions through multiple [statuses](https://stripe.com/docs/payments/intents#intent-statuses) as it guides
 * you through the setup process.
 * 
 * Successful SetupIntents result in payment credentials that are optimized for future payments.
 * For example, cardholders in [certain regions](/guides/strong-customer-authentication) may need to be run through
 * [Strong Customer Authentication](https://stripe.com/docs/strong-customer-authentication) at the time of payment method collection
 * in order to streamline later [off-session payments](https://stripe.com/docs/payments/setup-intents).
 * If the SetupIntent is used with a [Customer](https://stripe.com/docs/api#setup_intent_object-customer), upon success,
 * it will automatically attach the resulting payment method to that Customer.
 * We recommend using SetupIntents or [setup_future_usage](https://stripe.com/docs/api#payment_intent_object-setup_future_usage) on
 * PaymentIntents to save payment methods in order to prevent saving invalid or unoptimized payment methods.
 * 
 * By using SetupIntents, you ensure that your customers experience the minimum set of required friction,
 * even as regulations change over time.
 * 
 * Related guide: [Setup Intents API](https://stripe.com/docs/payments/setup-intents).
 */
export interface SetupIntent {
  /**
   * ID of the Connect application that created the SetupIntent.
   */
  application?: (string | Application | null)
  /**
   * If present, the SetupIntent's payment method will be attached to the in-context Stripe Account.
   * 
   * It can only be used for this Stripe Account’s own money movement flows like InboundTransfer and OutboundTransfers. It cannot be set to true when setting up a PaymentMethod for a Customer, and defaults to false when attaching a PaymentMethod to a Customer.
   */
  attach_to_self?: boolean
  /**
   * Reason for cancellation of this SetupIntent, one of `abandoned`, `requested_by_customer`, or `duplicate`.
   */
  cancellation_reason?: ("abandoned" | "duplicate" | "requested_by_customer" | null)
  /**
   * The client secret of this SetupIntent. Used for client-side retrieval using a publishable key.
   * 
   * The client secret can be used to complete payment setup from your frontend. It should not be stored, logged, or exposed to anyone other than the customer. Make sure that you have TLS enabled on any page that includes the client secret.
   */
  client_secret?: (string | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * ID of the Customer this SetupIntent belongs to, if one exists.
   * 
   * If present, the SetupIntent's payment method will be attached to the Customer on successful setup. Payment methods attached to other Customers cannot be used with this SetupIntent.
   */
  customer?: (string | Customer | DeletedCustomer | null)
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * Indicates the directions of money movement for which this payment method is intended to be used.
   * 
   * Include `inbound` if you intend to use the payment method as the origin to pull funds from. Include `outbound` if you intend to use the payment method as the destination to send funds to. You can include both if you intend to use the payment method for both purposes.
   */
  flow_directions?: (("inbound" | "outbound")[] | null)
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * The error encountered in the previous SetupIntent confirmation.
   */
  last_setup_error?: (APIErrors | null)
  /**
   * The most recent SetupAttempt for this SetupIntent.
   */
  latest_attempt?: (string | PaymentFlowsSetupIntentSetupAttempt | null)
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * ID of the multi use Mandate generated by the SetupIntent.
   */
  mandate?: (string | Mandate | null)
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * If present, this property tells you what actions you need to take in order for your customer to continue payment setup.
   */
  next_action?: (SetupIntentNextAction | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "setup_intent"
  /**
   * The account (if any) for which the setup is intended.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * ID of the payment method used with this SetupIntent.
   */
  payment_method?: (string | PaymentMethod | null)
  /**
   * Payment-method-specific configuration for this SetupIntent.
   */
  payment_method_options?: (SetupIntentPaymentMethodOptions | null)
  /**
   * The list of payment method types (e.g. card) that this SetupIntent is allowed to set up.
   */
  payment_method_types: string[]
  /**
   * ID of the single_use Mandate generated by the SetupIntent.
   */
  single_use_mandate?: (string | Mandate | null)
  /**
   * [Status](https://stripe.com/docs/payments/intents#intent-statuses) of this SetupIntent, one of `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, `canceled`, or `succeeded`.
   */
  status: ("canceled" | "processing" | "requires_action" | "requires_confirmation" | "requires_payment_method" | "succeeded")
  /**
   * Indicates how the payment method is intended to be used in the future.
   * 
   * Use `on_session` if you intend to only reuse the payment method when the customer is in your checkout flow. Use `off_session` if your customer may or may not be in your checkout flow. If not provided, this value defaults to `off_session`.
   */
  usage: string
}
export interface SetupIntentNextAction {
  redirect_to_url?: SetupIntentNextActionRedirectToUrl
  /**
   * Type of the next action to perform, one of `redirect_to_url`, `use_stripe_sdk`, `alipay_handle_redirect`, `oxxo_display_details`, or `verify_with_microdeposits`.
   */
  type: string
  /**
   * When confirming a SetupIntent with Stripe.js, Stripe.js depends on the contents of this dictionary to invoke authentication flows. The shape of the contents is subject to change and is only intended to be used by Stripe.js.
   */
  use_stripe_sdk?: {

  }
  verify_with_microdeposits?: SetupIntentNextActionVerifyWithMicrodeposits
}
export interface SetupIntentNextActionRedirectToUrl {
  /**
   * If the customer does not exit their browser while authenticating, they will be redirected to this specified URL after completion.
   */
  return_url?: (string | null)
  /**
   * The URL you must redirect your customer to in order to authenticate.
   */
  url?: (string | null)
}
export interface SetupIntentNextActionVerifyWithMicrodeposits {
  /**
   * The timestamp when the microdeposits are expected to land.
   */
  arrival_date: number
  /**
   * The URL for the hosted verification page, which allows customers to verify their bank account.
   */
  hosted_verification_url: string
  /**
   * The type of the microdeposit sent to the customer. Used to distinguish between different verification methods.
   */
  microdeposit_type?: ("amounts" | "descriptor_code" | null)
}
export interface SetupIntentPaymentMethodOptions {
  acss_debit?: (SetupIntentPaymentMethodOptionsAcssDebit | SetupIntentTypeSpecificPaymentMethodOptionsClient)
  blik?: (SetupIntentPaymentMethodOptionsBlik | SetupIntentTypeSpecificPaymentMethodOptionsClient)
  card?: SetupIntentPaymentMethodOptionsCard
  link?: (SetupIntentPaymentMethodOptionsLink | SetupIntentTypeSpecificPaymentMethodOptionsClient)
  sepa_debit?: (SetupIntentPaymentMethodOptionsSepaDebit | SetupIntentTypeSpecificPaymentMethodOptionsClient)
  us_bank_account?: (SetupIntentPaymentMethodOptionsUsBankAccount | SetupIntentTypeSpecificPaymentMethodOptionsClient)
}
export interface SetupIntentPaymentMethodOptionsAcssDebit {
  /**
   * Currency supported by the bank account
   */
  currency?: ("cad" | "usd" | null)
  mandate_options?: SetupIntentPaymentMethodOptionsMandateOptionsAcssDebit
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant" | "microdeposits")
}
export interface SetupIntentPaymentMethodOptionsMandateOptionsAcssDebit {
  /**
   * A URL for custom mandate text
   */
  custom_mandate_url?: string
  /**
   * List of Stripe products where this mandate can be selected automatically.
   */
  default_for?: ("invoice" | "subscription")[]
  /**
   * Description of the interval. Only required if the 'payment_schedule' parameter is 'interval' or 'combined'.
   */
  interval_description?: (string | null)
  /**
   * Payment schedule for the mandate.
   */
  payment_schedule?: ("combined" | "interval" | "sporadic" | null)
  /**
   * Transaction type of the mandate.
   */
  transaction_type?: ("business" | "personal" | null)
}
export interface SetupIntentTypeSpecificPaymentMethodOptionsClient {
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant" | "microdeposits")
}
export interface SetupIntentPaymentMethodOptionsBlik {
  mandate_options?: SetupIntentPaymentMethodOptionsMandateOptionsBlik
}
export interface SetupIntentPaymentMethodOptionsMandateOptionsBlik {
  /**
   * Date at which the mandate expires.
   */
  expires_after?: (number | null)
  off_session?: MandateOptionsOffSessionDetailsBlik
  /**
   * Type of the mandate.
   */
  type?: ("off_session" | "on_session" | null)
}
export interface SetupIntentPaymentMethodOptionsCard {
  /**
   * Configuration options for setting up an eMandate for cards issued in India.
   */
  mandate_options?: (SetupIntentPaymentMethodOptionsCardMandateOptions | null)
  /**
   * Selected network to process this SetupIntent on. Depends on the available networks of the card attached to the setup intent. Can be only set confirm-time.
   */
  network?: ("amex" | "cartes_bancaires" | "diners" | "discover" | "interac" | "jcb" | "mastercard" | "unionpay" | "unknown" | "visa" | null)
  /**
   * We strongly recommend that you rely on our SCA Engine to automatically prompt your customers for authentication based on risk level and [other requirements](https://stripe.com/docs/strong-customer-authentication). However, if you wish to request 3D Secure based on logic from your own fraud engine, provide this option. Permitted values include: `automatic` or `any`. If not provided, defaults to `automatic`. Read our guide on [manually requesting 3D Secure](https://stripe.com/docs/payments/3d-secure#manual-three-ds) for more information on how this configuration interacts with Radar and our SCA Engine.
   */
  request_three_d_secure?: ("any" | "automatic" | "challenge_only" | null)
}
export interface SetupIntentPaymentMethodOptionsCardMandateOptions {
  /**
   * Amount to be charged for future payments.
   */
  amount: number
  /**
   * One of `fixed` or `maximum`. If `fixed`, the `amount` param refers to the exact amount to be charged in future payments. If `maximum`, the amount charged can be up to the value passed for the `amount` param.
   */
  amount_type: ("fixed" | "maximum")
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * A description of the mandate or subscription that is meant to be displayed to the customer.
   */
  description?: (string | null)
  /**
   * End date of the mandate or subscription. If not provided, the mandate will be active until canceled. If provided, end date should be after start date.
   */
  end_date?: (number | null)
  /**
   * Specifies payment frequency. One of `day`, `week`, `month`, `year`, or `sporadic`.
   */
  interval: ("day" | "month" | "sporadic" | "week" | "year")
  /**
   * The number of intervals between payments. For example, `interval=month` and `interval_count=3` indicates one payment every three months. Maximum of one year interval allowed (1 year, 12 months, or 52 weeks). This parameter is optional when `interval=sporadic`.
   */
  interval_count?: (number | null)
  /**
   * Unique identifier for the mandate or subscription.
   */
  reference: string
  /**
   * Start date of the mandate or subscription. Start date should not be lesser than yesterday.
   */
  start_date: number
  /**
   * Specifies the type of mandates supported. Possible values are `india`.
   */
  supported_types?: (("india")[] | null)
}
export interface SetupIntentPaymentMethodOptionsLink {
  /**
   * Token used for persistent Link logins.
   */
  persistent_token?: (string | null)
}
export interface SetupIntentPaymentMethodOptionsSepaDebit {
  mandate_options?: SetupIntentPaymentMethodOptionsMandateOptionsSepaDebit
}
export interface SetupIntentPaymentMethodOptionsMandateOptionsSepaDebit {

}
export interface SetupIntentPaymentMethodOptionsUsBankAccount {
  financial_connections?: LinkedAccountOptionsUsBankAccount
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant" | "microdeposits")
}
export interface LinkedAccountOptionsUsBankAccount {
  /**
   * The list of permissions to request. The `payment_method` permission must be included.
   */
  permissions?: ("balances" | "ownership" | "payment_method" | "transactions")[]
  /**
   * For webview integrations only. Upon completing OAuth login in the native browser, the user will be redirected to this URL to return to your app.
   */
  return_url?: string
}
/**
 * Pending Updates store the changes pending from a previous update that will be applied
 * to the Subscription upon successful payment.
 */
export interface SubscriptionsResourcePendingUpdate {
  /**
   * If the update is applied, determines the date of the first full invoice, and, for plans with `month` or `year` intervals, the day of the month for subsequent invoices. The timestamp is in UTC format.
   */
  billing_cycle_anchor?: (number | null)
  /**
   * The point after which the changes reflected by this update will be discarded and no longer applied.
   */
  expires_at: number
  /**
   * List of subscription items, each with an attached plan, that will be set if the update is applied.
   */
  subscription_items?: (SubscriptionItem[] | null)
  /**
   * Unix timestamp representing the end of the trial period the customer will get before being charged for the first time, if the update is applied.
   */
  trial_end?: (number | null)
  /**
   * Indicates if a plan's `trial_period_days` should be applied to the subscription. Setting `trial_end` per subscription is preferred, and this defaults to `false`. Setting this flag to `true` together with `trial_end` is not allowed. See [Using trial periods on subscriptions](https://stripe.com/docs/billing/subscriptions/trials) to learn more.
   */
  trial_from_plan?: (boolean | null)
}
/**
 * A subscription schedule allows you to create and manage the lifecycle of a subscription by predefining expected changes.
 * 
 * Related guide: [Subscription Schedules](https://stripe.com/docs/billing/subscriptions/subscription-schedules).
 */
export interface SubscriptionSchedule {
  /**
   * ID of the Connect Application that created the schedule.
   */
  application?: (string | Application | DeletedApplication | null)
  /**
   * Time at which the subscription schedule was canceled. Measured in seconds since the Unix epoch.
   */
  canceled_at?: (number | null)
  /**
   * Time at which the subscription schedule was completed. Measured in seconds since the Unix epoch.
   */
  completed_at?: (number | null)
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Object representing the start and end dates for the current phase of the subscription schedule, if it is `active`.
   */
  current_phase?: (SubscriptionScheduleCurrentPhase | null)
  /**
   * ID of the customer who owns the subscription schedule.
   */
  customer: (string | Customer | DeletedCustomer)
  default_settings: SubscriptionSchedulesResourceDefaultSettings
  /**
   * Behavior of the subscription schedule and underlying subscription when it ends. Possible values are `release` or `cancel` with the default being `release`. `release` will end the subscription schedule and keep the underlying subscription running.`cancel` will end the subscription schedule and cancel the underlying subscription.
   */
  end_behavior: ("cancel" | "none" | "release" | "renew")
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "subscription_schedule"
  /**
   * Configuration for the subscription schedule's phases.
   */
  phases: SubscriptionSchedulePhaseConfiguration[]
  /**
   * Time at which the subscription schedule was released. Measured in seconds since the Unix epoch.
   */
  released_at?: (number | null)
  /**
   * ID of the subscription once managed by the subscription schedule (if it is released).
   */
  released_subscription?: (string | null)
  /**
   * The present status of the subscription schedule. Possible values are `not_started`, `active`, `completed`, `released`, and `canceled`. You can read more about the different states in our [behavior guide](https://stripe.com/docs/billing/subscriptions/subscription-schedules).
   */
  status: ("active" | "canceled" | "completed" | "not_started" | "released")
  /**
   * ID of the subscription managed by the subscription schedule.
   */
  subscription?: (string | Subscription | null)
  /**
   * ID of the test clock this subscription schedule belongs to.
   */
  test_clock?: (string | TestClock | null)
}
export interface SubscriptionScheduleCurrentPhase {
  /**
   * The end of this phase of the subscription schedule.
   */
  end_date: number
  /**
   * The start of this phase of the subscription schedule.
   */
  start_date: number
}
export interface SubscriptionSchedulesResourceDefaultSettings {
  /**
   * A non-negative decimal between 0 and 100, with at most two decimal places. This represents the percentage of the subscription invoice subtotal that will be transferred to the application owner's Stripe account during this phase of the schedule.
   */
  application_fee_percent?: (number | null)
  automatic_tax?: SubscriptionSchedulesResourceDefaultSettingsAutomaticTax
  /**
   * Possible values are `phase_start` or `automatic`. If `phase_start` then billing cycle anchor of the subscription is set to the start of the phase when entering the phase. If `automatic` then the billing cycle anchor is automatically modified as needed when entering the phase. For more information, see the billing cycle [documentation](https://stripe.com/docs/billing/subscriptions/billing-cycle).
   */
  billing_cycle_anchor: ("automatic" | "phase_start")
  /**
   * Define thresholds at which an invoice will be sent, and the subscription advanced to a new billing period
   */
  billing_thresholds?: (SubscriptionBillingThresholds | null)
  /**
   * Either `charge_automatically`, or `send_invoice`. When charging automatically, Stripe will attempt to pay the underlying subscription at the end of each billing cycle using the default source attached to the customer. When sending an invoice, Stripe will email your customer an invoice with payment instructions and mark the subscription as `active`.
   */
  collection_method?: ("charge_automatically" | "send_invoice" | null)
  /**
   * ID of the default payment method for the subscription schedule. If not set, invoices will use the default payment method in the customer's invoice settings.
   */
  default_payment_method?: (string | PaymentMethod | null)
  /**
   * Subscription description, meant to be displayable to the customer. Use this field to optionally store an explanation of the subscription.
   */
  description?: (string | null)
  /**
   * The subscription schedule's default invoice settings.
   */
  invoice_settings?: (InvoiceSettingSubscriptionScheduleSetting | null)
  /**
   * The account (if any) the charge was made on behalf of for charges associated with the schedule's subscription. See the Connect documentation for details.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * The account (if any) the associated subscription's payments will be attributed to for tax reporting, and where funds from each payment will be transferred to for each of the subscription's invoices.
   */
  transfer_data?: (SubscriptionTransferData | null)
}
export interface SubscriptionSchedulesResourceDefaultSettingsAutomaticTax {
  /**
   * Whether Stripe automatically computes tax on invoices created during this phase.
   */
  enabled: boolean
}
export interface InvoiceSettingSubscriptionScheduleSetting {
  /**
   * Number of days within which a customer must pay invoices generated by this subscription schedule. This value will be `null` for subscription schedules where `billing=charge_automatically`.
   */
  days_until_due?: (number | null)
}
export interface SubscriptionTransferData {
  /**
   * A non-negative decimal between 0 and 100, with at most two decimal places. This represents the percentage of the subscription invoice subtotal that will be transferred to the destination account. By default, the entire amount is transferred to the destination.
   */
  amount_percent?: (number | null)
  /**
   * The account where funds from the payment will be transferred to upon payment success.
   */
  destination: (string | Account)
}
/**
 * A phase describes the plans, coupon, and trialing status of a subscription for a predefined time period.
 */
export interface SubscriptionSchedulePhaseConfiguration {
  /**
   * A list of prices and quantities that will generate invoice items appended to the next invoice for this phase.
   */
  add_invoice_items: SubscriptionScheduleAddInvoiceItem[]
  /**
   * A non-negative decimal between 0 and 100, with at most two decimal places. This represents the percentage of the subscription invoice subtotal that will be transferred to the application owner's Stripe account during this phase of the schedule.
   */
  application_fee_percent?: (number | null)
  automatic_tax?: SchedulesPhaseAutomaticTax
  /**
   * Possible values are `phase_start` or `automatic`. If `phase_start` then billing cycle anchor of the subscription is set to the start of the phase when entering the phase. If `automatic` then the billing cycle anchor is automatically modified as needed when entering the phase. For more information, see the billing cycle [documentation](https://stripe.com/docs/billing/subscriptions/billing-cycle).
   */
  billing_cycle_anchor?: ("automatic" | "phase_start" | null)
  /**
   * Define thresholds at which an invoice will be sent, and the subscription advanced to a new billing period
   */
  billing_thresholds?: (SubscriptionBillingThresholds | null)
  /**
   * Either `charge_automatically`, or `send_invoice`. When charging automatically, Stripe will attempt to pay the underlying subscription at the end of each billing cycle using the default source attached to the customer. When sending an invoice, Stripe will email your customer an invoice with payment instructions and mark the subscription as `active`.
   */
  collection_method?: ("charge_automatically" | "send_invoice" | null)
  /**
   * ID of the coupon to use during this phase of the subscription schedule.
   */
  coupon?: (string | Coupon | DeletedCoupon | null)
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * ID of the default payment method for the subscription schedule. It must belong to the customer associated with the subscription schedule. If not set, invoices will use the default payment method in the customer's invoice settings.
   */
  default_payment_method?: (string | PaymentMethod | null)
  /**
   * The default tax rates to apply to the subscription during this phase of the subscription schedule.
   */
  default_tax_rates?: (TaxRate[] | null)
  /**
   * Subscription description, meant to be displayable to the customer. Use this field to optionally store an explanation of the subscription.
   */
  description?: (string | null)
  /**
   * The end of this phase of the subscription schedule.
   */
  end_date: number
  /**
   * The invoice settings applicable during this phase.
   */
  invoice_settings?: (InvoiceSettingSubscriptionScheduleSetting | null)
  /**
   * Subscription items to configure the subscription to during this phase of the subscription schedule.
   */
  items: SubscriptionScheduleConfigurationItem[]
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to a phase. Metadata on a schedule's phase will update the underlying subscription's `metadata` when the phase is entered. Updating the underlying subscription's `metadata` directly will not affect the current phase's `metadata`.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * The account (if any) the charge was made on behalf of for charges associated with the schedule's subscription. See the Connect documentation for details.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * If the subscription schedule will prorate when transitioning to this phase. Possible values are `create_prorations` and `none`.
   */
  proration_behavior: ("always_invoice" | "create_prorations" | "none")
  /**
   * The start of this phase of the subscription schedule.
   */
  start_date: number
  /**
   * The account (if any) the associated subscription's payments will be attributed to for tax reporting, and where funds from each payment will be transferred to for each of the subscription's invoices.
   */
  transfer_data?: (SubscriptionTransferData | null)
  /**
   * When the trial ends within the phase.
   */
  trial_end?: (number | null)
  minItems?: 0
}
/**
 * An Add Invoice Item describes the prices and quantities that will be added as pending invoice items when entering a phase.
 */
export interface SubscriptionScheduleAddInvoiceItem {
  /**
   * ID of the price used to generate the invoice item.
   */
  price: (string | Price | DeletedPrice)
  /**
   * The quantity of the invoice item.
   */
  quantity?: (number | null)
  /**
   * The tax rates which apply to the item. When set, the `default_tax_rates` do not apply to this item.
   */
  tax_rates?: (TaxRate[] | null)
}
export interface DeletedPrice {
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "price"
}
export interface SchedulesPhaseAutomaticTax {
  /**
   * Whether Stripe automatically computes tax on invoices created during this phase.
   */
  enabled: boolean
}
export interface DeletedCoupon {
  /**
   * Always true for a deleted object
   */
  deleted: true
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "coupon"
}
/**
 * A phase item describes the price and quantity of a phase.
 */
export interface SubscriptionScheduleConfigurationItem {
  /**
   * Define thresholds at which an invoice will be sent, and the related subscription advanced to a new billing period
   */
  billing_thresholds?: (SubscriptionItemBillingThresholds | null)
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an item. Metadata on this item will update the underlying subscription item's `metadata` when the phase is entered.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * ID of the price to which the customer should be subscribed.
   */
  price: (string | Price | DeletedPrice)
  /**
   * Quantity of the plan to which the customer should be subscribed.
   */
  quantity?: number
  /**
   * The tax rates which apply to this `phase_item`. When set, the `default_tax_rates` on the phase do not apply to this `phase_item`.
   */
  tax_rates?: (TaxRate[] | null)
}
/**
 * A test clock enables deterministic control over objects in testmode. With a test clock, you can create
 * objects at a frozen time in the past or future, and advance to a specific future time to observe webhooks and state changes. After the clock advances,
 * you can either validate the current state of your scenario (and test your assumptions), change the current state of your scenario (and test more complex scenarios), or keep advancing forward in time.
 */
export interface TestClock {
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * Time at which this clock is scheduled to auto delete.
   */
  deletes_after: number
  /**
   * Time at which all objects belonging to this clock are frozen.
   */
  frozen_time: number
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * The custom name supplied at creation.
   */
  name?: (string | null)
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "test_helpers.test_clock"
  /**
   * The status of the Test Clock.
   */
  status: ("advancing" | "internal_failure" | "ready")
}
/**
 * Configures how this subscription behaves during the trial period.
 */
export interface SubscriptionsTrialsResourceTrialSettings {
  end_behavior: SubscriptionsTrialsResourceEndBehavior
}
/**
 * Defines how a subscription behaves when a free trial ends.
 */
export interface SubscriptionsTrialsResourceEndBehavior {
  /**
   * Indicates how the subscription should change when the trial ends if the user did not provide a payment method.
   */
  missing_payment_method: ("cancel" | "create_invoice" | "pause")
}
export interface QuotesResourceSubscriptionDataSubscriptionData {
  /**
   * The subscription's description, meant to be displayable to the customer. Use this field to optionally store an explanation of the subscription.
   */
  description?: (string | null)
  /**
   * When creating a new subscription, the date of which the subscription schedule will start after the quote is accepted. This date is ignored if it is in the past when the quote is accepted. Measured in seconds since the Unix epoch.
   */
  effective_date?: (number | null)
  /**
   * Integer representing the number of trial period days before the customer is charged for the first time.
   */
  trial_period_days?: (number | null)
}
export interface QuotesResourceTransferData {
  /**
   * The amount in %s that will be transferred to the destination account when the invoice is paid. By default, the entire amount is transferred to the destination.
   */
  amount?: (number | null)
  /**
   * A non-negative decimal between 0 and 100, with at most two decimal places. This represents the percentage of the subscription invoice subtotal that will be transferred to the destination account. By default, the entire amount will be transferred to the destination.
   */
  amount_percent?: (number | null)
  /**
   * The account where funds from the payment will be transferred to upon payment success.
   */
  destination: (string | Account)
}
export interface InvoiceSettingRenderingOptions {
  /**
   * How line-item prices and amounts will be displayed with respect to tax on invoice PDFs.
   */
  amount_tax_display?: (string | null)
}
export interface InvoicesShippingCost {
  /**
   * Total shipping cost before any taxes are applied.
   */
  amount_subtotal: number
  /**
   * Total tax amount applied due to shipping costs. If no tax was applied, defaults to 0.
   */
  amount_tax: number
  /**
   * Total shipping cost after taxes are applied.
   */
  amount_total: number
  /**
   * The ID of the ShippingRate for this invoice.
   */
  shipping_rate?: (string | ShippingRate | null)
  /**
   * The taxes applied to the shipping rate.
   */
  taxes?: LineItemsTaxAmount[]
}
/**
 * Shipping rates describe the price of shipping presented to your customers and can be
 * applied to [Checkout Sessions](https://stripe.com/docs/payments/checkout/shipping)
 * and [Orders](https://stripe.com/docs/orders/shipping) to collect shipping costs.
 */
export interface ShippingRate {
  /**
   * Whether the shipping rate can be used for new purchases. Defaults to `true`.
   */
  active: boolean
  /**
   * Time at which the object was created. Measured in seconds since the Unix epoch.
   */
  created: number
  /**
   * The estimated range for how long shipping will take, meant to be displayable to the customer. This will appear on CheckoutSessions.
   */
  delivery_estimate?: (ShippingRateDeliveryEstimate | null)
  /**
   * The name of the shipping rate, meant to be displayable to the customer. This will appear on CheckoutSessions.
   */
  display_name?: (string | null)
  fixed_amount?: ShippingRateFixedAmount
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "shipping_rate"
  /**
   * Specifies whether the rate is considered inclusive of taxes or exclusive of taxes. One of `inclusive`, `exclusive`, or `unspecified`.
   */
  tax_behavior?: ("exclusive" | "inclusive" | "unspecified" | null)
  /**
   * A [tax code](https://stripe.com/docs/tax/tax-categories) ID. The Shipping tax code is `txcd_92010001`.
   */
  tax_code?: (string | TaxProductResourceTaxCode | null)
  /**
   * The type of calculation to use on the shipping rate. Can only be `fixed_amount` for now.
   */
  type: "fixed_amount"
}
export interface ShippingRateDeliveryEstimate {
  /**
   * The upper bound of the estimated range. If empty, represents no upper bound i.e., infinite.
   */
  maximum?: (ShippingRateDeliveryEstimateBound | null)
  /**
   * The lower bound of the estimated range. If empty, represents no lower bound.
   */
  minimum?: (ShippingRateDeliveryEstimateBound | null)
}
export interface ShippingRateDeliveryEstimateBound {
  /**
   * A unit of time.
   */
  unit: ("business_day" | "day" | "hour" | "month" | "week")
  /**
   * Must be greater than 0.
   */
  value: number
}
export interface ShippingRateFixedAmount {
  /**
   * A non-negative integer in cents representing how much to charge.
   */
  amount: number
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * Shipping rates defined in each available currency option. Each key must be a three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html) and a [supported currency](https://stripe.com/docs/currencies).
   */
  currency_options?: {
    [k: string]: ShippingRateCurrencyOption
  }
}
export interface ShippingRateCurrencyOption {
  /**
   * A non-negative integer in cents representing how much to charge.
   */
  amount: number
  /**
   * Specifies whether the rate is considered inclusive of taxes or exclusive of taxes. One of `inclusive`, `exclusive`, or `unspecified`.
   */
  tax_behavior: ("exclusive" | "inclusive" | "unspecified")
}
export interface InvoicesStatusTransitions {
  /**
   * The time that the invoice draft was finalized.
   */
  finalized_at?: (number | null)
  /**
   * The time that the invoice was marked uncollectible.
   */
  marked_uncollectible_at?: (number | null)
  /**
   * The time that the invoice was paid.
   */
  paid_at?: (number | null)
  /**
   * The time that the invoice was voided.
   */
  voided_at?: (number | null)
}
export interface InvoiceThresholdReason {
  /**
   * The total invoice amount threshold boundary if it triggered the threshold invoice.
   */
  amount_gte?: (number | null)
  /**
   * Indicates which line items triggered a threshold invoice.
   */
  item_reasons: InvoiceItemThresholdReason[]
}
export interface InvoiceItemThresholdReason {
  /**
   * The IDs of the line items that triggered the threshold invoice.
   */
  line_item_ids: string[]
  /**
   * The quantity threshold boundary that applied to the given line item.
   */
  usage_gte: number
}
export interface InvoiceTransferData {
  /**
   * The amount in %s that will be transferred to the destination account when the invoice is paid. By default, the entire amount is transferred to the destination.
   */
  amount?: (number | null)
  /**
   * The account where funds from the payment will be transferred to upon payment success.
   */
  destination: (string | Account)
}
export interface PaymentIntentNextAction {
  alipay_handle_redirect?: PaymentIntentNextActionAlipayHandleRedirect
  boleto_display_details?: PaymentIntentNextActionBoleto
  card_await_notification?: PaymentIntentNextActionCardAwaitNotification
  display_bank_transfer_instructions?: PaymentIntentNextActionDisplayBankTransferInstructions
  konbini_display_details?: PaymentIntentNextActionKonbini
  oxxo_display_details?: PaymentIntentNextActionDisplayOxxoDetails
  paynow_display_qr_code?: PaymentIntentNextActionPaynowDisplayQrCode
  pix_display_qr_code?: PaymentIntentNextActionPixDisplayQrCode
  promptpay_display_qr_code?: PaymentIntentNextActionPromptpayDisplayQrCode
  redirect_to_url?: PaymentIntentNextActionRedirectToUrl
  /**
   * Type of the next action to perform, one of `redirect_to_url`, `use_stripe_sdk`, `alipay_handle_redirect`, `oxxo_display_details`, or `verify_with_microdeposits`.
   */
  type: string
  /**
   * When confirming a PaymentIntent with Stripe.js, Stripe.js depends on the contents of this dictionary to invoke authentication flows. The shape of the contents is subject to change and is only intended to be used by Stripe.js.
   */
  use_stripe_sdk?: {

  }
  verify_with_microdeposits?: PaymentIntentNextActionVerifyWithMicrodeposits
  wechat_pay_display_qr_code?: PaymentIntentNextActionWechatPayDisplayQrCode
  wechat_pay_redirect_to_android_app?: PaymentIntentNextActionWechatPayRedirectToAndroidApp
  wechat_pay_redirect_to_ios_app?: PaymentIntentNextActionWechatPayRedirectToIOSApp
}
export interface PaymentIntentNextActionAlipayHandleRedirect {
  /**
   * The native data to be used with Alipay SDK you must redirect your customer to in order to authenticate the payment in an Android App.
   */
  native_data?: (string | null)
  /**
   * The native URL you must redirect your customer to in order to authenticate the payment in an iOS App.
   */
  native_url?: (string | null)
  /**
   * If the customer does not exit their browser while authenticating, they will be redirected to this specified URL after completion.
   */
  return_url?: (string | null)
  /**
   * The URL you must redirect your customer to in order to authenticate the payment.
   */
  url?: (string | null)
}
export interface PaymentIntentNextActionBoleto {
  /**
   * The timestamp after which the boleto expires.
   */
  expires_at?: (number | null)
  /**
   * The URL to the hosted boleto voucher page, which allows customers to view the boleto voucher.
   */
  hosted_voucher_url?: (string | null)
  /**
   * The boleto number.
   */
  number?: (string | null)
  /**
   * The URL to the downloadable boleto voucher PDF.
   */
  pdf?: (string | null)
}
export interface PaymentIntentNextActionCardAwaitNotification {
  /**
   * The time that payment will be attempted. If customer approval is required, they need to provide approval before this time.
   */
  charge_attempt_at?: (number | null)
  /**
   * For payments greater than INR 15000, the customer must provide explicit approval of the payment with their bank. For payments of lower amount, no customer action is required.
   */
  customer_approval_required?: (boolean | null)
}
export interface PaymentIntentNextActionDisplayBankTransferInstructions {
  /**
   * The remaining amount that needs to be transferred to complete the payment.
   */
  amount_remaining?: (number | null)
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency?: (string | null)
  /**
   * A list of financial addresses that can be used to fund the customer balance
   */
  financial_addresses?: FundingInstructionsBankTransferFinancialAddress[]
  /**
   * A link to a hosted page that guides your customer through completing the transfer.
   */
  hosted_instructions_url?: (string | null)
  /**
   * A string identifying this payment. Instruct your customer to include this code in the reference or memo field of their bank transfer.
   */
  reference?: (string | null)
  /**
   * Type of bank transfer
   */
  type: ("eu_bank_transfer" | "gb_bank_transfer" | "jp_bank_transfer" | "mx_bank_transfer")
}
/**
 * FinancialAddresses contain identifying information that resolves to a FinancialAccount.
 */
export interface FundingInstructionsBankTransferFinancialAddress {
  iban?: FundingInstructionsBankTransferIbanRecord
  sort_code?: FundingInstructionsBankTransferSortCodeRecord
  spei?: FundingInstructionsBankTransferSpeiRecord
  /**
   * The payment networks supported by this FinancialAddress
   */
  supported_networks?: ("bacs" | "fps" | "sepa" | "spei" | "zengin")[]
  /**
   * The type of financial address
   */
  type: ("iban" | "sort_code" | "spei" | "zengin")
  zengin?: FundingInstructionsBankTransferZenginRecord
}
/**
 * Iban Records contain E.U. bank account details per the SEPA format.
 */
export interface FundingInstructionsBankTransferIbanRecord {
  /**
   * The name of the person or business that owns the bank account
   */
  account_holder_name: string
  /**
   * The BIC/SWIFT code of the account.
   */
  bic: string
  /**
   * Two-letter country code ([ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2)).
   */
  country: string
  /**
   * The IBAN of the account.
   */
  iban: string
}
/**
 * Sort Code Records contain U.K. bank account details per the sort code format.
 */
export interface FundingInstructionsBankTransferSortCodeRecord {
  /**
   * The name of the person or business that owns the bank account
   */
  account_holder_name: string
  /**
   * The account number
   */
  account_number: string
  /**
   * The six-digit sort code
   */
  sort_code: string
}
/**
 * SPEI Records contain Mexico bank account details per the SPEI format.
 */
export interface FundingInstructionsBankTransferSpeiRecord {
  /**
   * The three-digit bank code
   */
  bank_code: string
  /**
   * The short banking institution name
   */
  bank_name: string
  /**
   * The CLABE number
   */
  clabe: string
}
/**
 * Zengin Records contain Japan bank account details per the Zengin format.
 */
export interface FundingInstructionsBankTransferZenginRecord {
  /**
   * The account holder name
   */
  account_holder_name?: (string | null)
  /**
   * The account number
   */
  account_number?: (string | null)
  /**
   * The bank account type. In Japan, this can only be `futsu` or `toza`.
   */
  account_type?: (string | null)
  /**
   * The bank code of the account
   */
  bank_code?: (string | null)
  /**
   * The bank name of the account
   */
  bank_name?: (string | null)
  /**
   * The branch code of the account
   */
  branch_code?: (string | null)
  /**
   * The branch name of the account
   */
  branch_name?: (string | null)
}
export interface PaymentIntentNextActionKonbini {
  /**
   * The timestamp at which the pending Konbini payment expires.
   */
  expires_at: number
  /**
   * The URL for the Konbini payment instructions page, which allows customers to view and print a Konbini voucher.
   */
  hosted_voucher_url?: (string | null)
  stores: PaymentIntentNextActionKonbiniStores
}
export interface PaymentIntentNextActionKonbiniStores {
  /**
   * FamilyMart instruction details.
   */
  familymart?: (PaymentIntentNextActionKonbiniFamilymart | null)
  /**
   * Lawson instruction details.
   */
  lawson?: (PaymentIntentNextActionKonbiniLawson | null)
  /**
   * Ministop instruction details.
   */
  ministop?: (PaymentIntentNextActionKonbiniMinistop | null)
  /**
   * Seicomart instruction details.
   */
  seicomart?: (PaymentIntentNextActionKonbiniSeicomart | null)
}
export interface PaymentIntentNextActionKonbiniFamilymart {
  /**
   * The confirmation number.
   */
  confirmation_number?: string
  /**
   * The payment code.
   */
  payment_code: string
}
export interface PaymentIntentNextActionKonbiniLawson {
  /**
   * The confirmation number.
   */
  confirmation_number?: string
  /**
   * The payment code.
   */
  payment_code: string
}
export interface PaymentIntentNextActionKonbiniMinistop {
  /**
   * The confirmation number.
   */
  confirmation_number?: string
  /**
   * The payment code.
   */
  payment_code: string
}
export interface PaymentIntentNextActionKonbiniSeicomart {
  /**
   * The confirmation number.
   */
  confirmation_number?: string
  /**
   * The payment code.
   */
  payment_code: string
}
export interface PaymentIntentNextActionDisplayOxxoDetails {
  /**
   * The timestamp after which the OXXO voucher expires.
   */
  expires_after?: (number | null)
  /**
   * The URL for the hosted OXXO voucher page, which allows customers to view and print an OXXO voucher.
   */
  hosted_voucher_url?: (string | null)
  /**
   * OXXO reference number.
   */
  number?: (string | null)
}
export interface PaymentIntentNextActionPaynowDisplayQrCode {
  /**
   * The raw data string used to generate QR code, it should be used together with QR code library.
   */
  data: string
  /**
   * The URL to the hosted PayNow instructions page, which allows customers to view the PayNow QR code.
   */
  hosted_instructions_url?: (string | null)
  /**
   * The image_url_png string used to render QR code
   */
  image_url_png: string
  /**
   * The image_url_svg string used to render QR code
   */
  image_url_svg: string
}
export interface PaymentIntentNextActionPixDisplayQrCode {
  /**
   * The raw data string used to generate QR code, it should be used together with QR code library.
   */
  data?: string
  /**
   * The date (unix timestamp) when the PIX expires.
   */
  expires_at?: number
  /**
   * The URL to the hosted pix instructions page, which allows customers to view the pix QR code.
   */
  hosted_instructions_url?: string
  /**
   * The image_url_png string used to render png QR code
   */
  image_url_png?: string
  /**
   * The image_url_svg string used to render svg QR code
   */
  image_url_svg?: string
}
export interface PaymentIntentNextActionPromptpayDisplayQrCode {
  /**
   * The raw data string used to generate QR code, it should be used together with QR code library.
   */
  data: string
  /**
   * The URL to the hosted PromptPay instructions page, which allows customers to view the PromptPay QR code.
   */
  hosted_instructions_url: string
  /**
   * The PNG path used to render the QR code, can be used as the source in an HTML img tag
   */
  image_url_png: string
  /**
   * The SVG path used to render the QR code, can be used as the source in an HTML img tag
   */
  image_url_svg: string
}
export interface PaymentIntentNextActionRedirectToUrl {
  /**
   * If the customer does not exit their browser while authenticating, they will be redirected to this specified URL after completion.
   */
  return_url?: (string | null)
  /**
   * The URL you must redirect your customer to in order to authenticate the payment.
   */
  url?: (string | null)
}
export interface PaymentIntentNextActionVerifyWithMicrodeposits {
  /**
   * The timestamp when the microdeposits are expected to land.
   */
  arrival_date: number
  /**
   * The URL for the hosted verification page, which allows customers to verify their bank account.
   */
  hosted_verification_url: string
  /**
   * The type of the microdeposit sent to the customer. Used to distinguish between different verification methods.
   */
  microdeposit_type?: ("amounts" | "descriptor_code" | null)
}
export interface PaymentIntentNextActionWechatPayDisplayQrCode {
  /**
   * The data being used to generate QR code
   */
  data: string
  /**
   * The URL to the hosted WeChat Pay instructions page, which allows customers to view the WeChat Pay QR code.
   */
  hosted_instructions_url: string
  /**
   * The base64 image data for a pre-generated QR code
   */
  image_data_url: string
  /**
   * The image_url_png string used to render QR code
   */
  image_url_png: string
  /**
   * The image_url_svg string used to render QR code
   */
  image_url_svg: string
}
export interface PaymentIntentNextActionWechatPayRedirectToAndroidApp {
  /**
   * app_id is the APP ID registered on WeChat open platform
   */
  app_id: string
  /**
   * nonce_str is a random string
   */
  nonce_str: string
  /**
   * package is static value
   */
  package: string
  /**
   * an unique merchant ID assigned by WeChat Pay
   */
  partner_id: string
  /**
   * an unique trading ID assigned by WeChat Pay
   */
  prepay_id: string
  /**
   * A signature
   */
  sign: string
  /**
   * Specifies the current time in epoch format
   */
  timestamp: string
}
export interface PaymentIntentNextActionWechatPayRedirectToIOSApp {
  /**
   * An universal link that redirect to WeChat Pay app
   */
  native_url: string
}
export interface PaymentIntentPaymentMethodOptions {
  acss_debit?: (PaymentIntentPaymentMethodOptionsAcssDebit | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  affirm?: (PaymentMethodOptionsAffirm | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  afterpay_clearpay?: (PaymentMethodOptionsAfterpayClearpay | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  alipay?: (PaymentMethodOptionsAlipay | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  au_becs_debit?: (PaymentIntentPaymentMethodOptionsAuBecsDebit | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  bacs_debit?: (PaymentMethodOptionsBacsDebit | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  bancontact?: (PaymentMethodOptionsBancontact | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  blik?: (PaymentIntentPaymentMethodOptionsBlik | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  boleto?: (PaymentMethodOptionsBoleto | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  card?: (PaymentIntentPaymentMethodOptionsCard | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  card_present?: (PaymentMethodOptionsCardPresent | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  customer_balance?: (PaymentMethodOptionsCustomerBalance | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  eps?: (PaymentIntentPaymentMethodOptionsEps | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  fpx?: (PaymentMethodOptionsFpx | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  giropay?: (PaymentMethodOptionsGiropay | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  grabpay?: (PaymentMethodOptionsGrabpay | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  ideal?: (PaymentMethodOptionsIdeal | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  interac_present?: (PaymentMethodOptionsInteracPresent | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  klarna?: (PaymentMethodOptionsKlarna | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  konbini?: (PaymentMethodOptionsKonbini | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  link?: (PaymentIntentPaymentMethodOptionsLink | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  oxxo?: (PaymentMethodOptionsOxxo | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  p24?: (PaymentMethodOptionsP24 | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  paynow?: (PaymentMethodOptionsPaynow | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  pix?: (PaymentMethodOptionsPix | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  promptpay?: (PaymentMethodOptionsPromptpay | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  sepa_debit?: (PaymentIntentPaymentMethodOptionsSepaDebit | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  sofort?: (PaymentMethodOptionsSofort | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  us_bank_account?: (PaymentIntentPaymentMethodOptionsUsBankAccount | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
  wechat_pay?: (PaymentMethodOptionsWechatPay | PaymentIntentTypeSpecificPaymentMethodOptionsClient)
}
export interface PaymentIntentPaymentMethodOptionsAcssDebit {
  mandate_options?: PaymentIntentPaymentMethodOptionsMandateOptionsAcssDebit
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant" | "microdeposits")
}
export interface PaymentIntentPaymentMethodOptionsMandateOptionsAcssDebit {
  /**
   * A URL for custom mandate text
   */
  custom_mandate_url?: string
  /**
   * Description of the interval. Only required if the 'payment_schedule' parameter is 'interval' or 'combined'.
   */
  interval_description?: (string | null)
  /**
   * Payment schedule for the mandate.
   */
  payment_schedule?: ("combined" | "interval" | "sporadic" | null)
  /**
   * Transaction type of the mandate.
   */
  transaction_type?: ("business" | "personal" | null)
}
export interface PaymentIntentTypeSpecificPaymentMethodOptionsClient {
  /**
   * Controls when the funds will be captured from the customer's account.
   */
  capture_method?: ("manual" | "manual_preferred")
  installments?: PaymentFlowsInstallmentOptions
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant" | "microdeposits")
}
export interface PaymentFlowsInstallmentOptions {
  enabled: boolean
  plan?: PaymentMethodDetailsCardInstallmentsPlan
}
export interface PaymentMethodOptionsAffirm {
  /**
   * Controls when the funds will be captured from the customer's account.
   */
  capture_method?: "manual"
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsAfterpayClearpay {
  /**
   * Controls when the funds will be captured from the customer's account.
   */
  capture_method?: "manual"
  /**
   * Order identifier shown to the customer in Afterpay’s online portal. We recommend using a value that helps you answer any questions a customer might have about
   * the payment. The identifier is limited to 128 characters and may contain only letters, digits, underscores, backslashes and dashes.
   */
  reference?: (string | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsAlipay {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session")
}
export interface PaymentIntentPaymentMethodOptionsAuBecsDebit {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
}
export interface PaymentMethodOptionsBacsDebit {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
}
export interface PaymentMethodOptionsBancontact {
  /**
   * Preferred language of the Bancontact authorization page that the customer is redirected to.
   */
  preferred_language: ("de" | "en" | "fr" | "nl")
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session")
}
export interface PaymentIntentPaymentMethodOptionsBlik {

}
export interface PaymentMethodOptionsBoleto {
  /**
   * The number of calendar days before a Boleto voucher expires. For example, if you create a Boleto voucher on Monday and you set expires_after_days to 2, the Boleto voucher will expire on Wednesday at 23:59 America/Sao_Paulo time.
   */
  expires_after_days: number
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
}
export interface PaymentIntentPaymentMethodOptionsCard {
  /**
   * Controls when the funds will be captured from the customer's account.
   */
  capture_method?: "manual"
  /**
   * Installment details for this payment (Mexico only).
   * 
   * For more information, see the [installments integration guide](https://stripe.com/docs/payments/installments).
   */
  installments?: (PaymentMethodOptionsCardInstallments | null)
  /**
   * Configuration options for setting up an eMandate for cards issued in India.
   */
  mandate_options?: (PaymentMethodOptionsCardMandateOptions | null)
  /**
   * Selected network to process this payment intent on. Depends on the available networks of the card attached to the payment intent. Can be only set confirm-time.
   */
  network?: ("amex" | "cartes_bancaires" | "diners" | "discover" | "interac" | "jcb" | "mastercard" | "unionpay" | "unknown" | "visa" | null)
  /**
   * We strongly recommend that you rely on our SCA Engine to automatically prompt your customers for authentication based on risk level and [other requirements](https://stripe.com/docs/strong-customer-authentication). However, if you wish to request 3D Secure based on logic from your own fraud engine, provide this option. Permitted values include: `automatic` or `any`. If not provided, defaults to `automatic`. Read our guide on [manually requesting 3D Secure](https://stripe.com/docs/payments/3d-secure#manual-three-ds) for more information on how this configuration interacts with Radar and our SCA Engine.
   */
  request_three_d_secure?: ("any" | "automatic" | "challenge_only" | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
  /**
   * Provides information about a card payment that customers see on their statements. Concatenated with the Kana prefix (shortened Kana descriptor) or Kana statement descriptor that’s set on the account to form the complete statement descriptor. Maximum 22 characters. On card statements, the *concatenation* of both prefix and suffix (including separators) will appear truncated to 22 characters.
   */
  statement_descriptor_suffix_kana?: string
  /**
   * Provides information about a card payment that customers see on their statements. Concatenated with the Kanji prefix (shortened Kanji descriptor) or Kanji statement descriptor that’s set on the account to form the complete statement descriptor. Maximum 17 characters. On card statements, the *concatenation* of both prefix and suffix (including separators) will appear truncated to 17 characters.
   */
  statement_descriptor_suffix_kanji?: string
}
export interface PaymentMethodOptionsCardInstallments {
  /**
   * Installment plans that may be selected for this PaymentIntent.
   */
  available_plans?: (PaymentMethodDetailsCardInstallmentsPlan[] | null)
  /**
   * Whether Installments are enabled for this PaymentIntent.
   */
  enabled: boolean
  /**
   * Installment plan selected for this PaymentIntent.
   */
  plan?: (PaymentMethodDetailsCardInstallmentsPlan | null)
}
export interface PaymentMethodOptionsCardMandateOptions {
  /**
   * Amount to be charged for future payments.
   */
  amount: number
  /**
   * One of `fixed` or `maximum`. If `fixed`, the `amount` param refers to the exact amount to be charged in future payments. If `maximum`, the amount charged can be up to the value passed for the `amount` param.
   */
  amount_type: ("fixed" | "maximum")
  /**
   * A description of the mandate or subscription that is meant to be displayed to the customer.
   */
  description?: (string | null)
  /**
   * End date of the mandate or subscription. If not provided, the mandate will be active until canceled. If provided, end date should be after start date.
   */
  end_date?: (number | null)
  /**
   * Specifies payment frequency. One of `day`, `week`, `month`, `year`, or `sporadic`.
   */
  interval: ("day" | "month" | "sporadic" | "week" | "year")
  /**
   * The number of intervals between payments. For example, `interval=month` and `interval_count=3` indicates one payment every three months. Maximum of one year interval allowed (1 year, 12 months, or 52 weeks). This parameter is optional when `interval=sporadic`.
   */
  interval_count?: (number | null)
  /**
   * Unique identifier for the mandate or subscription.
   */
  reference: string
  /**
   * Start date of the mandate or subscription. Start date should not be lesser than yesterday.
   */
  start_date: number
  /**
   * Specifies the type of mandates supported. Possible values are `india`.
   */
  supported_types?: (("india")[] | null)
}
export interface PaymentMethodOptionsCardPresent {
  /**
   * Request ability to capture this payment beyond the standard [authorization validity window](https://stripe.com/docs/terminal/features/extended-authorizations#authorization-validity)
   */
  request_extended_authorization?: (boolean | null)
  /**
   * Request ability to [increment](https://stripe.com/docs/terminal/features/incremental-authorizations) this PaymentIntent if the combination of MCC and card brand is eligible. Check [incremental_authorization_supported](https://stripe.com/docs/api/charges/object#charge_object-payment_method_details-card_present-incremental_authorization_supported) in the [Confirm](https://stripe.com/docs/api/payment_intents/confirm) response to verify support.
   */
  request_incremental_authorization_support?: (boolean | null)
}
export interface PaymentMethodOptionsCustomerBalance {
  bank_transfer?: PaymentMethodOptionsCustomerBalanceBankTransfer
  /**
   * The funding method type to be used when there are not enough funds in the customer balance. Permitted values include: `bank_transfer`.
   */
  funding_type?: ("bank_transfer" | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsCustomerBalanceBankTransfer {
  eu_bank_transfer?: PaymentMethodOptionsCustomerBalanceEuBankAccount
  /**
   * List of address types that should be returned in the financial_addresses response. If not specified, all valid types will be returned.
   * 
   * Permitted values include: `sort_code`, `zengin`, `iban`, or `spei`.
   */
  requested_address_types?: ("iban" | "sepa" | "sort_code" | "spei" | "zengin")[]
  /**
   * The bank transfer type that this PaymentIntent is allowed to use for funding Permitted values include: `eu_bank_transfer`, `gb_bank_transfer`, `jp_bank_transfer`, or `mx_bank_transfer`.
   */
  type?: ("eu_bank_transfer" | "gb_bank_transfer" | "jp_bank_transfer" | "mx_bank_transfer" | null)
}
export interface PaymentMethodOptionsCustomerBalanceEuBankAccount {
  /**
   * The desired country code of the bank account information. Permitted values include: `BE`, `DE`, `ES`, `FR`, `IE`, or `NL`.
   */
  country: ("BE" | "DE" | "ES" | "FR" | "IE" | "NL")
}
export interface PaymentIntentPaymentMethodOptionsEps {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsFpx {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsGiropay {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsGrabpay {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsIdeal {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session")
}
export interface PaymentMethodOptionsInteracPresent {

}
export interface PaymentMethodOptionsKlarna {
  /**
   * Controls when the funds will be captured from the customer's account.
   */
  capture_method?: "manual"
  /**
   * Preferred locale of the Klarna checkout page that the customer is redirected to.
   */
  preferred_locale?: (string | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsKonbini {
  /**
   * An optional 10 to 11 digit numeric-only string determining the confirmation code at applicable convenience stores.
   */
  confirmation_number?: (string | null)
  /**
   * The number of calendar days (between 1 and 60) after which Konbini payment instructions will expire. For example, if a PaymentIntent is confirmed with Konbini and `expires_after_days` set to 2 on Monday JST, the instructions will expire on Wednesday 23:59:59 JST.
   */
  expires_after_days?: (number | null)
  /**
   * The timestamp at which the Konbini payment instructions will expire. Only one of `expires_after_days` or `expires_at` may be set.
   */
  expires_at?: (number | null)
  /**
   * A product descriptor of up to 22 characters, which will appear to customers at the convenience store.
   */
  product_description?: (string | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentIntentPaymentMethodOptionsLink {
  /**
   * Controls when the funds will be captured from the customer's account.
   */
  capture_method?: "manual"
  /**
   * Token used for persistent Link logins.
   */
  persistent_token?: (string | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session")
}
export interface PaymentMethodOptionsOxxo {
  /**
   * The number of calendar days before an OXXO invoice expires. For example, if you create an OXXO invoice on Monday and you set expires_after_days to 2, the OXXO invoice will expire on Wednesday at 23:59 America/Mexico_City time.
   */
  expires_after_days: number
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsP24 {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsPaynow {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsPix {
  /**
   * The number of seconds (between 10 and 1209600) after which Pix payment will expire.
   */
  expires_after_seconds?: (number | null)
  /**
   * The timestamp at which the Pix expires.
   */
  expires_at?: (number | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentMethodOptionsPromptpay {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentIntentPaymentMethodOptionsSepaDebit {
  mandate_options?: PaymentIntentPaymentMethodOptionsMandateOptionsSepaDebit
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
}
export interface PaymentIntentPaymentMethodOptionsMandateOptionsSepaDebit {

}
export interface PaymentMethodOptionsSofort {
  /**
   * Preferred language of the SOFORT authorization page that the customer is redirected to.
   */
  preferred_language?: ("de" | "en" | "es" | "fr" | "it" | "nl" | "pl" | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session")
}
export interface PaymentIntentPaymentMethodOptionsUsBankAccount {
  financial_connections?: LinkedAccountOptionsUsBankAccount
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant" | "microdeposits")
}
export interface PaymentMethodOptionsWechatPay {
  /**
   * The app ID registered with WeChat Pay. Only required when client is ios or android.
   */
  app_id?: (string | null)
  /**
   * The client type that the end customer will pay from
   */
  client?: ("android" | "ios" | "web" | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface PaymentIntentProcessing {
  card?: PaymentIntentCardProcessing
  /**
   * Type of the payment method for which payment is in `processing` state, one of `card`.
   */
  type: "card"
}
export interface PaymentIntentCardProcessing {
  customer_notification?: PaymentIntentProcessingCustomerNotification
}
export interface PaymentIntentProcessingCustomerNotification {
  /**
   * Whether customer approval has been requested for this payment. For payments greater than INR 15000 or mandate amount, the customer must provide explicit approval of the payment with their bank.
   */
  approval_requested?: (boolean | null)
  /**
   * If customer approval is required, they need to provide approval before this time.
   */
  completes_at?: (number | null)
}
export interface TransferData {
  /**
   * Amount intended to be collected by this PaymentIntent. A positive integer representing how much to charge in the [smallest currency unit](https://stripe.com/docs/currencies#zero-decimal) (e.g., 100 cents to charge $1.00 or 100 to charge ¥100, a zero-decimal currency). The minimum amount is $0.50 US or [equivalent in charge currency](https://stripe.com/docs/currencies#minimum-and-maximum-charge-amounts). The amount value supports up to eight digits (e.g., a value of 99999999 for a USD charge of $999,999.99).
   */
  amount?: number
  /**
   * The account (if any) the payment will be attributed to for tax
   * reporting, and where funds from the payment will be transferred to upon
   * payment success.
   */
  destination: (string | Account)
}
export interface Networks {
  /**
   * All available networks for the card.
   */
  available: string[]
  /**
   * The preferred network for the card.
   */
  preferred?: (string | null)
}
export interface ThreeDSecureUsage {
  /**
   * Whether 3D Secure is supported on this card.
   */
  supported: boolean
}
export interface PaymentMethodCardWallet {
  amex_express_checkout?: PaymentMethodCardWalletAmexExpressCheckout
  apple_pay?: PaymentMethodCardWalletApplePay
  /**
   * (For tokenized numbers only.) The last four digits of the device account number.
   */
  dynamic_last4?: (string | null)
  google_pay?: PaymentMethodCardWalletGooglePay
  masterpass?: PaymentMethodCardWalletMasterpass
  samsung_pay?: PaymentMethodCardWalletSamsungPay
  /**
   * The type of the card wallet, one of `amex_express_checkout`, `apple_pay`, `google_pay`, `masterpass`, `samsung_pay`, or `visa_checkout`. An additional hash is included on the Wallet subhash with a name matching this value. It contains additional information specific to the card wallet type.
   */
  type: ("amex_express_checkout" | "apple_pay" | "google_pay" | "masterpass" | "samsung_pay" | "visa_checkout")
  visa_checkout?: PaymentMethodCardWalletVisaCheckout
}
export interface PaymentMethodCardWalletAmexExpressCheckout {

}
export interface PaymentMethodCardWalletApplePay {

}
export interface PaymentMethodCardWalletGooglePay {

}
export interface PaymentMethodCardWalletMasterpass {
  /**
   * Owner's verified billing address. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  billing_address?: (Address | null)
  /**
   * Owner's verified email. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  email?: (string | null)
  /**
   * Owner's verified full name. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  name?: (string | null)
  /**
   * Owner's verified shipping address. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  shipping_address?: (Address | null)
}
export interface PaymentMethodCardWalletSamsungPay {

}
export interface PaymentMethodCardWalletVisaCheckout {
  /**
   * Owner's verified billing address. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  billing_address?: (Address | null)
  /**
   * Owner's verified email. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  email?: (string | null)
  /**
   * Owner's verified full name. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  name?: (string | null)
  /**
   * Owner's verified shipping address. Values are verified or provided by the wallet directly (if supported) at the time of authorization or settlement. They cannot be set or mutated.
   */
  shipping_address?: (Address | null)
}
export interface PaymentMethodCardPresent {

}
export interface PaymentMethodCustomerBalance {

}
export interface PaymentMethodEps {
  /**
   * The customer's bank. Should be one of `arzte_und_apotheker_bank`, `austrian_anadi_bank_ag`, `bank_austria`, `bankhaus_carl_spangler`, `bankhaus_schelhammer_und_schattera_ag`, `bawag_psk_ag`, `bks_bank_ag`, `brull_kallmus_bank_ag`, `btv_vier_lander_bank`, `capital_bank_grawe_gruppe_ag`, `deutsche_bank_ag`, `dolomitenbank`, `easybank_ag`, `erste_bank_und_sparkassen`, `hypo_alpeadriabank_international_ag`, `hypo_noe_lb_fur_niederosterreich_u_wien`, `hypo_oberosterreich_salzburg_steiermark`, `hypo_tirol_bank_ag`, `hypo_vorarlberg_bank_ag`, `hypo_bank_burgenland_aktiengesellschaft`, `marchfelder_bank`, `oberbank_ag`, `raiffeisen_bankengruppe_osterreich`, `schoellerbank_ag`, `sparda_bank_wien`, `volksbank_gruppe`, `volkskreditbank_ag`, or `vr_bank_braunau`.
   */
  bank?: ("arzte_und_apotheker_bank" | "austrian_anadi_bank_ag" | "bank_austria" | "bankhaus_carl_spangler" | "bankhaus_schelhammer_und_schattera_ag" | "bawag_psk_ag" | "bks_bank_ag" | "brull_kallmus_bank_ag" | "btv_vier_lander_bank" | "capital_bank_grawe_gruppe_ag" | "deutsche_bank_ag" | "dolomitenbank" | "easybank_ag" | "erste_bank_und_sparkassen" | "hypo_alpeadriabank_international_ag" | "hypo_bank_burgenland_aktiengesellschaft" | "hypo_noe_lb_fur_niederosterreich_u_wien" | "hypo_oberosterreich_salzburg_steiermark" | "hypo_tirol_bank_ag" | "hypo_vorarlberg_bank_ag" | "marchfelder_bank" | "oberbank_ag" | "raiffeisen_bankengruppe_osterreich" | "schoellerbank_ag" | "sparda_bank_wien" | "volksbank_gruppe" | "volkskreditbank_ag" | "vr_bank_braunau" | null)
}
export interface PaymentMethodFpx {
  /**
   * The customer's bank, if provided. Can be one of `affin_bank`, `agrobank`, `alliance_bank`, `ambank`, `bank_islam`, `bank_muamalat`, `bank_rakyat`, `bsn`, `cimb`, `hong_leong_bank`, `hsbc`, `kfh`, `maybank2u`, `ocbc`, `public_bank`, `rhb`, `standard_chartered`, `uob`, `deutsche_bank`, `maybank2e`, `pb_enterprise`, or `bank_of_china`.
   */
  bank: ("affin_bank" | "agrobank" | "alliance_bank" | "ambank" | "bank_islam" | "bank_muamalat" | "bank_of_china" | "bank_rakyat" | "bsn" | "cimb" | "deutsche_bank" | "hong_leong_bank" | "hsbc" | "kfh" | "maybank2e" | "maybank2u" | "ocbc" | "pb_enterprise" | "public_bank" | "rhb" | "standard_chartered" | "uob")
}
export interface PaymentMethodGiropay {

}
export interface PaymentMethodGrabpay {

}
export interface PaymentMethodIdeal {
  /**
   * The customer's bank, if provided. Can be one of `abn_amro`, `asn_bank`, `bunq`, `handelsbanken`, `ing`, `knab`, `moneyou`, `rabobank`, `regiobank`, `revolut`, `sns_bank`, `triodos_bank`, `van_lanschot`, or `yoursafe`.
   */
  bank?: ("abn_amro" | "asn_bank" | "bunq" | "handelsbanken" | "ing" | "knab" | "moneyou" | "rabobank" | "regiobank" | "revolut" | "sns_bank" | "triodos_bank" | "van_lanschot" | "yoursafe" | null)
  /**
   * The Bank Identifier Code of the customer's bank, if the bank was provided.
   */
  bic?: ("ABNANL2A" | "ASNBNL21" | "BITSNL2A" | "BUNQNL2A" | "FVLBNL22" | "HANDNL2A" | "INGBNL2A" | "KNABNL2H" | "MOYONL21" | "RABONL2U" | "RBRBNL21" | "REVOLT21" | "SNSBNL2A" | "TRIONL2U" | null)
}
export interface PaymentMethodInteracPresent {

}
export interface PaymentMethodKlarna {
  /**
   * The customer's date of birth, if provided.
   */
  dob?: (PaymentFlowsPrivatePaymentMethodsKlarnaDOB | null)
}
export interface PaymentFlowsPrivatePaymentMethodsKlarnaDOB {
  /**
   * The day of birth, between 1 and 31.
   */
  day?: (number | null)
  /**
   * The month of birth, between 1 and 12.
   */
  month?: (number | null)
  /**
   * The four-digit year of birth.
   */
  year?: (number | null)
}
export interface PaymentMethodKonbini {

}
export interface PaymentMethodLink {
  /**
   * Account owner's email address.
   */
  email?: (string | null)
  /**
   * Token used for persistent Link logins.
   */
  persistent_token?: string
}
export interface PaymentMethodOxxo {

}
export interface PaymentMethodP24 {
  /**
   * The customer's bank, if provided.
   */
  bank?: ("alior_bank" | "bank_millennium" | "bank_nowy_bfg_sa" | "bank_pekao_sa" | "banki_spbdzielcze" | "blik" | "bnp_paribas" | "boz" | "citi_handlowy" | "credit_agricole" | "envelobank" | "etransfer_pocztowy24" | "getin_bank" | "ideabank" | "ing" | "inteligo" | "mbank_mtransfer" | "nest_przelew" | "noble_pay" | "pbac_z_ipko" | "plus_bank" | "santander_przelew24" | "tmobile_usbugi_bankowe" | "toyota_bank" | "volkswagen_bank" | null)
}
export interface PaymentMethodPaynow {

}
export interface PaymentMethodPix {

}
export interface PaymentMethodPromptpay {

}
export interface PaymentMethodSepaDebit {
  /**
   * Bank code of bank associated with the bank account.
   */
  bank_code?: (string | null)
  /**
   * Branch code of bank associated with the bank account.
   */
  branch_code?: (string | null)
  /**
   * Two-letter ISO code representing the country the bank account is located in.
   */
  country?: (string | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Information about the object that generated this PaymentMethod.
   */
  generated_from?: (SepaDebitGeneratedFrom | null)
  /**
   * Last four characters of the IBAN.
   */
  last4?: (string | null)
}
export interface SepaDebitGeneratedFrom {
  /**
   * The ID of the Charge that generated this PaymentMethod, if any.
   */
  charge?: (string | Charge | null)
  /**
   * The ID of the SetupAttempt that generated this PaymentMethod, if any.
   */
  setup_attempt?: (string | PaymentFlowsSetupIntentSetupAttempt | null)
}
export interface PaymentMethodSofort {
  /**
   * Two-letter ISO code representing the country the bank account is located in.
   */
  country?: (string | null)
}
export interface PaymentMethodUsBankAccount {
  /**
   * Account holder type: individual or company.
   */
  account_holder_type?: ("company" | "individual" | null)
  /**
   * Account type: checkings or savings. Defaults to checking if omitted.
   */
  account_type?: ("checking" | "savings" | null)
  /**
   * The name of the bank.
   */
  bank_name?: (string | null)
  /**
   * The ID of the Financial Connections Account used to create the payment method.
   */
  financial_connections_account?: (string | null)
  /**
   * Uniquely identifies this particular bank account. You can use this attribute to check whether two bank accounts are the same.
   */
  fingerprint?: (string | null)
  /**
   * Last four digits of the bank account number.
   */
  last4?: (string | null)
  /**
   * Contains information about US bank account networks that can be used.
   */
  networks?: (UsBankAccountNetworks | null)
  /**
   * Routing number of the bank account.
   */
  routing_number?: (string | null)
}
export interface UsBankAccountNetworks {
  /**
   * The preferred network.
   */
  preferred?: (string | null)
  /**
   * All supported networks.
   */
  supported: ("ach" | "us_domestic_wire")[]
}
export interface PaymentMethodWechatPay {

}
/**
 * The customer's payment sources, if any.
 */
export interface ApmsSourcesSourceList {
  /**
   * Details about each object.
   */
  data: Polymorphic1[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
/**
 * The customer's current subscriptions, if any.
 */
export interface SubscriptionList {
  /**
   * Details about each object.
   */
  data: Subscription[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
export interface CustomerTax {
  /**
   * Surfaces if automatic tax computation is possible given the current customer location information.
   */
  automatic_tax: ("failed" | "not_collecting" | "supported" | "unrecognized_location")
  /**
   * A recent IP address of the customer used for tax reporting and tax location inference.
   */
  ip_address?: (string | null)
  /**
   * The customer's location as identified by Stripe Tax.
   */
  location?: (CustomerTaxLocation | null)
}
export interface CustomerTaxLocation {
  /**
   * The customer's country as identified by Stripe Tax.
   */
  country: string
  /**
   * The data source used to infer the customer's location.
   */
  source: ("billing_address" | "ip_address" | "payment_method" | "shipping_destination")
  /**
   * The customer's state, county, province, or region as identified by Stripe Tax.
   */
  state?: (string | null)
}
/**
 * The customer's tax IDs.
 */
export interface TaxIDsList {
  /**
   * Details about each object.
   */
  data: TaxId[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
export interface PaymentPagesCheckoutSessionCustomerDetails {
  /**
   * The customer's address after a completed Checkout Session. Note: This property is populated only for sessions on or after March 30, 2022.
   */
  address?: (Address | null)
  /**
   * The email associated with the Customer, if one exists, on the Checkout Session after a completed Checkout Session or at time of session expiry.
   * Otherwise, if the customer has consented to promotional content, this value is the most recent valid email provided by the customer on the Checkout form.
   */
  email?: (string | null)
  /**
   * The customer's name after a completed Checkout Session. Note: This property is populated only for sessions on or after March 30, 2022.
   */
  name?: (string | null)
  /**
   * The customer's phone number after a completed Checkout Session.
   */
  phone?: (string | null)
  /**
   * The customer’s tax exempt status after a completed Checkout Session.
   */
  tax_exempt?: ("exempt" | "none" | "reverse" | null)
  /**
   * The customer’s tax IDs after a completed Checkout Session.
   */
  tax_ids?: (PaymentPagesCheckoutSessionTaxID[] | null)
}
export interface PaymentPagesCheckoutSessionTaxID {
  /**
   * The type of the tax ID, one of `eu_vat`, `br_cnpj`, `br_cpf`, `eu_oss_vat`, `gb_vat`, `nz_gst`, `au_abn`, `au_arn`, `in_gst`, `no_vat`, `za_vat`, `ch_vat`, `mx_rfc`, `sg_uen`, `ru_inn`, `ru_kpp`, `ca_bn`, `hk_br`, `es_cif`, `tw_vat`, `th_vat`, `jp_cn`, `jp_rn`, `jp_trn`, `li_uid`, `my_itn`, `us_ein`, `kr_brn`, `ca_qst`, `ca_gst_hst`, `ca_pst_bc`, `ca_pst_mb`, `ca_pst_sk`, `my_sst`, `sg_gst`, `ae_trn`, `cl_tin`, `sa_vat`, `id_npwp`, `my_frp`, `il_vat`, `ge_vat`, `ua_vat`, `is_vat`, `bg_uic`, `hu_tin`, `si_tin`, `ke_pin`, `tr_tin`, `eg_tin`, `ph_tin`, or `unknown`
   */
  type: ("ae_trn" | "au_abn" | "au_arn" | "bg_uic" | "br_cnpj" | "br_cpf" | "ca_bn" | "ca_gst_hst" | "ca_pst_bc" | "ca_pst_mb" | "ca_pst_sk" | "ca_qst" | "ch_vat" | "cl_tin" | "eg_tin" | "es_cif" | "eu_oss_vat" | "eu_vat" | "gb_vat" | "ge_vat" | "hk_br" | "hu_tin" | "id_npwp" | "il_vat" | "in_gst" | "is_vat" | "jp_cn" | "jp_rn" | "jp_trn" | "ke_pin" | "kr_brn" | "li_uid" | "mx_rfc" | "my_frp" | "my_itn" | "my_sst" | "no_vat" | "nz_gst" | "ph_tin" | "ru_inn" | "ru_kpp" | "sa_vat" | "sg_gst" | "sg_uen" | "si_tin" | "th_vat" | "tr_tin" | "tw_vat" | "ua_vat" | "unknown" | "us_ein" | "za_vat")
  /**
   * The value of the tax ID.
   */
  value?: (string | null)
}
export interface PaymentPagesCheckoutSessionInvoiceCreation {
  /**
   * Indicates whether invoice creation is enabled for the Checkout Session.
   */
  enabled: boolean
  invoice_data: PaymentPagesCheckoutSessionInvoiceSettings
}
export interface PaymentPagesCheckoutSessionInvoiceSettings {
  /**
   * The account tax IDs associated with the invoice.
   */
  account_tax_ids?: ((string | TaxId | DeletedTaxId)[] | null)
  /**
   * Custom fields displayed on the invoice.
   */
  custom_fields?: (InvoiceSettingCustomField[] | null)
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * Footer displayed on the invoice.
   */
  footer?: (string | null)
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * Options for invoice PDF rendering.
   */
  rendering_options?: (InvoiceSettingRenderingOptions | null)
}
/**
 * The line items purchased by the customer.
 */
export interface PaymentPagesCheckoutSessionListLineItems {
  /**
   * Details about each object.
   */
  data: LineItem[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
/**
 * A payment link is a shareable URL that will take your customers to a hosted payment page. A payment link can be shared and used multiple times.
 * 
 * When a customer opens a payment link it will open a new [checkout session](https://stripe.com/docs/api/checkout/sessions) to render the payment page. You can use [checkout session events](https://stripe.com/docs/api/events/types#event_types-checkout.session.completed) to track payments through payment links.
 * 
 * Related guide: [Payment Links API](https://stripe.com/docs/payments/payment-links/api)
 */
export interface PaymentLink {
  /**
   * Whether the payment link's `url` is active. If `false`, customers visiting the URL will be shown a page saying that the link has been deactivated.
   */
  active: boolean
  after_completion: PaymentLinksResourceAfterCompletion
  /**
   * Whether user redeemable promotion codes are enabled.
   */
  allow_promotion_codes: boolean
  /**
   * The amount of the application fee (if any) that will be requested to be applied to the payment and transferred to the application owner's Stripe account.
   */
  application_fee_amount?: (number | null)
  /**
   * This represents the percentage of the subscription invoice subtotal that will be transferred to the application owner's Stripe account.
   */
  application_fee_percent?: (number | null)
  automatic_tax: PaymentLinksResourceAutomaticTax
  /**
   * Configuration for collecting the customer's billing address.
   */
  billing_address_collection: ("auto" | "required")
  /**
   * When set, provides configuration to gather active consent from customers.
   */
  consent_collection?: (PaymentLinksResourceConsentCollection | null)
  /**
   * Three-letter [ISO currency code](https://www.iso.org/iso-4217-currency-codes.html), in lowercase. Must be a [supported currency](https://stripe.com/docs/currencies).
   */
  currency: string
  /**
   * Collect additional information from your customer using custom fields. Up to 2 fields are supported.
   */
  custom_fields: PaymentLinksResourceCustomFields[]
  custom_text: PaymentLinksResourceCustomText
  /**
   * Configuration for Customer creation during checkout.
   */
  customer_creation: ("always" | "if_required")
  /**
   * Unique identifier for the object.
   */
  id: string
  /**
   * Configuration for creating invoice for payment mode payment links.
   */
  invoice_creation?: (PaymentLinksResourceInvoiceCreation | null)
  line_items?: PaymentLinksResourceListLineItems
  /**
   * Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.
   */
  livemode: boolean
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata: {
    [k: string]: string
  }
  /**
   * String representing the object's type. Objects of the same type share the same value.
   */
  object: "payment_link"
  /**
   * The account on behalf of which to charge. See the [Connect documentation](https://support.stripe.com/questions/sending-invoices-on-behalf-of-connected-accounts) for details.
   */
  on_behalf_of?: (string | Account | null)
  /**
   * Indicates the parameters to be passed to PaymentIntent creation during checkout.
   */
  payment_intent_data?: (PaymentLinksResourcePaymentIntentData | null)
  /**
   * Configuration for collecting a payment method during checkout.
   */
  payment_method_collection: ("always" | "if_required")
  /**
   * The list of payment method types that customers can use. When `null`, Stripe will dynamically show relevant payment methods you've enabled in your [payment method settings](https://dashboard.stripe.com/settings/payment_methods).
   */
  payment_method_types?: (("affirm" | "afterpay_clearpay" | "alipay" | "au_becs_debit" | "bacs_debit" | "bancontact" | "blik" | "boleto" | "card" | "eps" | "fpx" | "giropay" | "grabpay" | "ideal" | "klarna" | "konbini" | "oxxo" | "p24" | "paynow" | "pix" | "promptpay" | "sepa_debit" | "sofort" | "us_bank_account" | "wechat_pay")[] | null)
  phone_number_collection: PaymentLinksResourcePhoneNumberCollection
  /**
   * Configuration for collecting the customer's shipping address.
   */
  shipping_address_collection?: (PaymentLinksResourceShippingAddressCollection | null)
  /**
   * The shipping rate options applied to the session.
   */
  shipping_options: PaymentLinksResourceShippingOption[]
  /**
   * Indicates the type of transaction being performed which customizes relevant text on the page, such as the submit button.
   */
  submit_type: ("auto" | "book" | "donate" | "pay")
  /**
   * When creating a subscription, the specified configuration data will be used. There must be at least one line item with a recurring price to use `subscription_data`.
   */
  subscription_data?: (PaymentLinksResourceSubscriptionData | null)
  tax_id_collection: PaymentLinksResourceTaxIdCollection
  /**
   * The account (if any) the payments will be attributed to for tax reporting, and where funds from each payment will be transferred to.
   */
  transfer_data?: (PaymentLinksResourceTransferData | null)
  /**
   * The public URL that can be shared with customers.
   */
  url: string
}
export interface PaymentLinksResourceAfterCompletion {
  hosted_confirmation?: PaymentLinksResourceCompletionBehaviorConfirmationPage
  redirect?: PaymentLinksResourceCompletionBehaviorRedirect
  /**
   * The specified behavior after the purchase is complete.
   */
  type: ("hosted_confirmation" | "redirect")
}
export interface PaymentLinksResourceCompletionBehaviorConfirmationPage {
  /**
   * The custom message that is displayed to the customer after the purchase is complete.
   */
  custom_message?: (string | null)
}
export interface PaymentLinksResourceCompletionBehaviorRedirect {
  /**
   * The URL the customer will be redirected to after the purchase is complete.
   */
  url: string
}
export interface PaymentLinksResourceAutomaticTax {
  /**
   * If `true`, tax will be calculated automatically using the customer's location.
   */
  enabled: boolean
}
export interface PaymentLinksResourceConsentCollection {
  /**
   * If set to `auto`, enables the collection of customer consent for promotional communications.
   */
  promotions?: ("auto" | "none" | null)
  /**
   * If set to `required`, it requires cutomers to accept the terms of service before being able to pay. If set to `none`, customers won't be shown a checkbox to accept the terms of service.
   */
  terms_of_service?: ("none" | "required" | null)
}
export interface PaymentLinksResourceCustomFields {
  /**
   * Configuration for `type=dropdown` fields.
   */
  dropdown?: (PaymentLinksResourceCustomFieldsDropdown | null)
  /**
   * String of your choice that your integration can use to reconcile this field. Must be unique to this field, alphanumeric, and up to 200 characters.
   */
  key: string
  label: PaymentLinksResourceCustomFieldsLabel
  /**
   * Whether the customer is required to complete the field before completing the Checkout Session. Defaults to `false`.
   */
  optional: boolean
  /**
   * The type of the field.
   */
  type: ("dropdown" | "numeric" | "text")
}
export interface PaymentLinksResourceCustomFieldsDropdown {
  /**
   * The options available for the customer to select. Up to 200 options allowed.
   */
  options: PaymentLinksResourceCustomFieldsDropdownOption[]
}
export interface PaymentLinksResourceCustomFieldsDropdownOption {
  /**
   * The label for the option, displayed to the customer. Up to 100 characters.
   */
  label: string
  /**
   * The value for this option, not displayed to the customer, used by your integration to reconcile the option selected by the customer. Must be unique to this option, alphanumeric, and up to 100 characters.
   */
  value: string
}
export interface PaymentLinksResourceCustomFieldsLabel {
  /**
   * Custom text for the label, displayed to the customer. Up to 50 characters.
   */
  custom?: (string | null)
  /**
   * The type of the label.
   */
  type: "custom"
}
export interface PaymentLinksResourceCustomText {
  /**
   * Custom text that should be displayed alongside shipping address collection.
   */
  shipping_address?: (PaymentLinksResourceCustomTextPosition | null)
  /**
   * Custom text that should be displayed alongside the payment confirmation button.
   */
  submit?: (PaymentLinksResourceCustomTextPosition | null)
}
export interface PaymentLinksResourceCustomTextPosition {
  /**
   * Text may be up to 1000 characters in length.
   */
  message: string
}
export interface PaymentLinksResourceInvoiceCreation {
  /**
   * Enable creating an invoice on successful payment.
   */
  enabled: boolean
  /**
   * Configuration for the invoice. Default invoice values will be used if unspecified.
   */
  invoice_data?: (PaymentLinksResourceInvoiceSettings | null)
}
export interface PaymentLinksResourceInvoiceSettings {
  /**
   * The account tax IDs associated with the invoice.
   */
  account_tax_ids?: ((string | TaxId | DeletedTaxId)[] | null)
  /**
   * A list of up to 4 custom fields to be displayed on the invoice.
   */
  custom_fields?: (InvoiceSettingCustomField[] | null)
  /**
   * An arbitrary string attached to the object. Often useful for displaying to users.
   */
  description?: (string | null)
  /**
   * Footer to be displayed on the invoice.
   */
  footer?: (string | null)
  /**
   * Set of [key-value pairs](https://stripe.com/docs/api/metadata) that you can attach to an object. This can be useful for storing additional information about the object in a structured format.
   */
  metadata?: ({
    [k: string]: string
  } | null)
  /**
   * Options for invoice PDF rendering.
   */
  rendering_options?: (InvoiceSettingRenderingOptions | null)
}
/**
 * The line items representing what is being sold.
 */
export interface PaymentLinksResourceListLineItems {
  /**
   * Details about each object.
   */
  data: LineItem[]
  /**
   * True if this list has another page of items after this one that can be fetched.
   */
  has_more: boolean
  /**
   * String representing the object's type. Objects of the same type share the same value. Always has the value `list`.
   */
  object: "list"
  /**
   * The URL where this list can be accessed.
   */
  url: string
}
export interface PaymentLinksResourcePaymentIntentData {
  /**
   * Indicates when the funds will be captured from the customer's account.
   */
  capture_method?: ("automatic" | "manual" | null)
  /**
   * Indicates that you intend to make future payments with the payment method collected during checkout.
   */
  setup_future_usage?: ("off_session" | "on_session" | null)
}
export interface PaymentLinksResourcePhoneNumberCollection {
  /**
   * If `true`, a phone number will be collected during checkout.
   */
  enabled: boolean
}
export interface PaymentLinksResourceShippingAddressCollection {
  /**
   * An array of two-letter ISO country codes representing which countries Checkout should provide as options for shipping locations. Unsupported country codes: `AS, CX, CC, CU, HM, IR, KP, MH, FM, NF, MP, PW, SD, SY, UM, VI`.
   */
  allowed_countries: ("AC" | "AD" | "AE" | "AF" | "AG" | "AI" | "AL" | "AM" | "AO" | "AQ" | "AR" | "AT" | "AU" | "AW" | "AX" | "AZ" | "BA" | "BB" | "BD" | "BE" | "BF" | "BG" | "BH" | "BI" | "BJ" | "BL" | "BM" | "BN" | "BO" | "BQ" | "BR" | "BS" | "BT" | "BV" | "BW" | "BY" | "BZ" | "CA" | "CD" | "CF" | "CG" | "CH" | "CI" | "CK" | "CL" | "CM" | "CN" | "CO" | "CR" | "CV" | "CW" | "CY" | "CZ" | "DE" | "DJ" | "DK" | "DM" | "DO" | "DZ" | "EC" | "EE" | "EG" | "EH" | "ER" | "ES" | "ET" | "FI" | "FJ" | "FK" | "FO" | "FR" | "GA" | "GB" | "GD" | "GE" | "GF" | "GG" | "GH" | "GI" | "GL" | "GM" | "GN" | "GP" | "GQ" | "GR" | "GS" | "GT" | "GU" | "GW" | "GY" | "HK" | "HN" | "HR" | "HT" | "HU" | "ID" | "IE" | "IL" | "IM" | "IN" | "IO" | "IQ" | "IS" | "IT" | "JE" | "JM" | "JO" | "JP" | "KE" | "KG" | "KH" | "KI" | "KM" | "KN" | "KR" | "KW" | "KY" | "KZ" | "LA" | "LB" | "LC" | "LI" | "LK" | "LR" | "LS" | "LT" | "LU" | "LV" | "LY" | "MA" | "MC" | "MD" | "ME" | "MF" | "MG" | "MK" | "ML" | "MM" | "MN" | "MO" | "MQ" | "MR" | "MS" | "MT" | "MU" | "MV" | "MW" | "MX" | "MY" | "MZ" | "NA" | "NC" | "NE" | "NG" | "NI" | "NL" | "NO" | "NP" | "NR" | "NU" | "NZ" | "OM" | "PA" | "PE" | "PF" | "PG" | "PH" | "PK" | "PL" | "PM" | "PN" | "PR" | "PS" | "PT" | "PY" | "QA" | "RE" | "RO" | "RS" | "RU" | "RW" | "SA" | "SB" | "SC" | "SE" | "SG" | "SH" | "SI" | "SJ" | "SK" | "SL" | "SM" | "SN" | "SO" | "SR" | "SS" | "ST" | "SV" | "SX" | "SZ" | "TA" | "TC" | "TD" | "TF" | "TG" | "TH" | "TJ" | "TK" | "TL" | "TM" | "TN" | "TO" | "TR" | "TT" | "TV" | "TW" | "TZ" | "UA" | "UG" | "US" | "UY" | "UZ" | "VA" | "VC" | "VE" | "VG" | "VN" | "VU" | "WF" | "WS" | "XK" | "YE" | "YT" | "ZA" | "ZM" | "ZW" | "ZZ")[]
}
export interface PaymentLinksResourceShippingOption {
  /**
   * A non-negative integer in cents representing how much to charge.
   */
  shipping_amount: number
  /**
   * The ID of the Shipping Rate to use for this shipping option.
   */
  shipping_rate: (string | ShippingRate)
}
export interface PaymentLinksResourceSubscriptionData {
  /**
   * The subscription's description, meant to be displayable to the customer. Use this field to optionally store an explanation of the subscription.
   */
  description?: (string | null)
  /**
   * Integer representing the number of trial period days before the customer is charged for the first time.
   */
  trial_period_days?: (number | null)
}
export interface PaymentLinksResourceTaxIdCollection {
  /**
   * Indicates whether tax ID collection is enabled for the session.
   */
  enabled: boolean
}
export interface PaymentLinksResourceTransferData {
  /**
   * The amount in %s that will be transferred to the destination account. By default, the entire amount is transferred to the destination.
   */
  amount?: (number | null)
  /**
   * The connected account receiving the transfer.
   */
  destination: (string | Account)
}
export interface CheckoutSessionPaymentMethodOptions {
  acss_debit?: CheckoutAcssDebitPaymentMethodOptions
  affirm?: CheckoutAffirmPaymentMethodOptions
  afterpay_clearpay?: CheckoutAfterpayClearpayPaymentMethodOptions
  alipay?: CheckoutAlipayPaymentMethodOptions
  au_becs_debit?: CheckoutAuBecsDebitPaymentMethodOptions
  bacs_debit?: CheckoutBacsDebitPaymentMethodOptions
  bancontact?: CheckoutBancontactPaymentMethodOptions
  boleto?: CheckoutBoletoPaymentMethodOptions
  card?: CheckoutCardPaymentMethodOptions
  customer_balance?: CheckoutCustomerBalancePaymentMethodOptions
  eps?: CheckoutEpsPaymentMethodOptions
  fpx?: CheckoutFpxPaymentMethodOptions
  giropay?: CheckoutGiropayPaymentMethodOptions
  grabpay?: CheckoutGrabPayPaymentMethodOptions
  ideal?: CheckoutIdealPaymentMethodOptions
  klarna?: CheckoutKlarnaPaymentMethodOptions
  konbini?: CheckoutKonbiniPaymentMethodOptions
  oxxo?: CheckoutOxxoPaymentMethodOptions
  p24?: CheckoutP24PaymentMethodOptions
  paynow?: CheckoutPaynowPaymentMethodOptions
  pix?: CheckoutPixPaymentMethodOptions
  sepa_debit?: CheckoutSepaDebitPaymentMethodOptions
  sofort?: CheckoutSofortPaymentMethodOptions
  us_bank_account?: CheckoutUsBankAccountPaymentMethodOptions
}
export interface CheckoutAcssDebitPaymentMethodOptions {
  /**
   * Currency supported by the bank account. Returned when the Session is in `setup` mode.
   */
  currency?: ("cad" | "usd")
  mandate_options?: CheckoutAcssDebitMandateOptions
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant" | "microdeposits")
}
export interface CheckoutAcssDebitMandateOptions {
  /**
   * A URL for custom mandate text
   */
  custom_mandate_url?: string
  /**
   * List of Stripe products where this mandate can be selected automatically. Returned when the Session is in `setup` mode.
   */
  default_for?: ("invoice" | "subscription")[]
  /**
   * Description of the interval. Only required if the 'payment_schedule' parameter is 'interval' or 'combined'.
   */
  interval_description?: (string | null)
  /**
   * Payment schedule for the mandate.
   */
  payment_schedule?: ("combined" | "interval" | "sporadic" | null)
  /**
   * Transaction type of the mandate.
   */
  transaction_type?: ("business" | "personal" | null)
}
export interface CheckoutAffirmPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutAfterpayClearpayPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutAlipayPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutAuBecsDebitPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutBacsDebitPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
}
export interface CheckoutBancontactPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutBoletoPaymentMethodOptions {
  /**
   * The number of calendar days before a Boleto voucher expires. For example, if you create a Boleto voucher on Monday and you set expires_after_days to 2, the Boleto voucher will expire on Wednesday at 23:59 America/Sao_Paulo time.
   */
  expires_after_days: number
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
}
export interface CheckoutCardPaymentMethodOptions {
  installments?: CheckoutCardInstallmentsOptions
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
  /**
   * Provides information about a card payment that customers see on their statements. Concatenated with the Kana prefix (shortened Kana descriptor) or Kana statement descriptor that’s set on the account to form the complete statement descriptor. Maximum 22 characters. On card statements, the *concatenation* of both prefix and suffix (including separators) will appear truncated to 22 characters.
   */
  statement_descriptor_suffix_kana?: string
  /**
   * Provides information about a card payment that customers see on their statements. Concatenated with the Kanji prefix (shortened Kanji descriptor) or Kanji statement descriptor that’s set on the account to form the complete statement descriptor. Maximum 17 characters. On card statements, the *concatenation* of both prefix and suffix (including separators) will appear truncated to 17 characters.
   */
  statement_descriptor_suffix_kanji?: string
}
export interface CheckoutCardInstallmentsOptions {
  /**
   * Indicates if installments are enabled
   */
  enabled?: boolean
}
export interface CheckoutCustomerBalancePaymentMethodOptions {
  bank_transfer?: CheckoutCustomerBalanceBankTransferPaymentMethodOptions
  /**
   * The funding method type to be used when there are not enough funds in the customer balance. Permitted values include: `bank_transfer`.
   */
  funding_type?: ("bank_transfer" | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutCustomerBalanceBankTransferPaymentMethodOptions {
  eu_bank_transfer?: PaymentMethodOptionsCustomerBalanceEuBankAccount
  /**
   * List of address types that should be returned in the financial_addresses response. If not specified, all valid types will be returned.
   * 
   * Permitted values include: `sort_code`, `zengin`, `iban`, or `spei`.
   */
  requested_address_types?: ("iban" | "sepa" | "sort_code" | "spei" | "zengin")[]
  /**
   * The bank transfer type that this PaymentIntent is allowed to use for funding Permitted values include: `eu_bank_transfer`, `gb_bank_transfer`, `jp_bank_transfer`, or `mx_bank_transfer`.
   */
  type?: ("eu_bank_transfer" | "gb_bank_transfer" | "jp_bank_transfer" | "mx_bank_transfer" | null)
}
export interface CheckoutEpsPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutFpxPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutGiropayPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutGrabPayPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutIdealPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutKlarnaPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
}
export interface CheckoutKonbiniPaymentMethodOptions {
  /**
   * The number of calendar days (between 1 and 60) after which Konbini payment instructions will expire. For example, if a PaymentIntent is confirmed with Konbini and `expires_after_days` set to 2 on Monday JST, the instructions will expire on Wednesday 23:59:59 JST.
   */
  expires_after_days?: (number | null)
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutOxxoPaymentMethodOptions {
  /**
   * The number of calendar days before an OXXO invoice expires. For example, if you create an OXXO invoice on Monday and you set expires_after_days to 2, the OXXO invoice will expire on Wednesday at 23:59 America/Mexico_City time.
   */
  expires_after_days: number
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutP24PaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutPaynowPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutPixPaymentMethodOptions {
  /**
   * The number of seconds after which Pix payment will expire.
   */
  expires_after_seconds?: (number | null)
}
export interface CheckoutSepaDebitPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
}
export interface CheckoutSofortPaymentMethodOptions {
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: "none"
}
export interface CheckoutUsBankAccountPaymentMethodOptions {
  financial_connections?: LinkedAccountOptionsUsBankAccount
  /**
   * Indicates that you intend to make future payments with this PaymentIntent's payment method.
   * 
   * Providing this parameter will [attach the payment method](https://stripe.com/docs/payments/save-during-payment) to the PaymentIntent's Customer, if present, after the PaymentIntent is confirmed and any required actions from the user are complete. If no Customer was provided, the payment method can still be [attached](https://stripe.com/docs/api/payment_methods/attach) to a Customer after the transaction completes.
   * 
   * When processing card payments, Stripe also uses `setup_future_usage` to dynamically optimize your payment flow and comply with regional legislation and network rules, such as [SCA](https://stripe.com/docs/strong-customer-authentication).
   */
  setup_future_usage?: ("none" | "off_session" | "on_session")
  /**
   * Bank account verification method.
   */
  verification_method?: ("automatic" | "instant")
}
export interface PaymentPagesCheckoutSessionPhoneNumberCollection {
  /**
   * Indicates whether phone number collection is enabled for the session
   */
  enabled: boolean
}
export interface PaymentPagesCheckoutSessionShippingAddressCollection {
  /**
   * An array of two-letter ISO country codes representing which countries Checkout should provide as options for
   * shipping locations. Unsupported country codes: `AS, CX, CC, CU, HM, IR, KP, MH, FM, NF, MP, PW, SD, SY, UM, VI`.
   */
  allowed_countries: ("AC" | "AD" | "AE" | "AF" | "AG" | "AI" | "AL" | "AM" | "AO" | "AQ" | "AR" | "AT" | "AU" | "AW" | "AX" | "AZ" | "BA" | "BB" | "BD" | "BE" | "BF" | "BG" | "BH" | "BI" | "BJ" | "BL" | "BM" | "BN" | "BO" | "BQ" | "BR" | "BS" | "BT" | "BV" | "BW" | "BY" | "BZ" | "CA" | "CD" | "CF" | "CG" | "CH" | "CI" | "CK" | "CL" | "CM" | "CN" | "CO" | "CR" | "CV" | "CW" | "CY" | "CZ" | "DE" | "DJ" | "DK" | "DM" | "DO" | "DZ" | "EC" | "EE" | "EG" | "EH" | "ER" | "ES" | "ET" | "FI" | "FJ" | "FK" | "FO" | "FR" | "GA" | "GB" | "GD" | "GE" | "GF" | "GG" | "GH" | "GI" | "GL" | "GM" | "GN" | "GP" | "GQ" | "GR" | "GS" | "GT" | "GU" | "GW" | "GY" | "HK" | "HN" | "HR" | "HT" | "HU" | "ID" | "IE" | "IL" | "IM" | "IN" | "IO" | "IQ" | "IS" | "IT" | "JE" | "JM" | "JO" | "JP" | "KE" | "KG" | "KH" | "KI" | "KM" | "KN" | "KR" | "KW" | "KY" | "KZ" | "LA" | "LB" | "LC" | "LI" | "LK" | "LR" | "LS" | "LT" | "LU" | "LV" | "LY" | "MA" | "MC" | "MD" | "ME" | "MF" | "MG" | "MK" | "ML" | "MM" | "MN" | "MO" | "MQ" | "MR" | "MS" | "MT" | "MU" | "MV" | "MW" | "MX" | "MY" | "MZ" | "NA" | "NC" | "NE" | "NG" | "NI" | "NL" | "NO" | "NP" | "NR" | "NU" | "NZ" | "OM" | "PA" | "PE" | "PF" | "PG" | "PH" | "PK" | "PL" | "PM" | "PN" | "PR" | "PS" | "PT" | "PY" | "QA" | "RE" | "RO" | "RS" | "RU" | "RW" | "SA" | "SB" | "SC" | "SE" | "SG" | "SH" | "SI" | "SJ" | "SK" | "SL" | "SM" | "SN" | "SO" | "SR" | "SS" | "ST" | "SV" | "SX" | "SZ" | "TA" | "TC" | "TD" | "TF" | "TG" | "TH" | "TJ" | "TK" | "TL" | "TM" | "TN" | "TO" | "TR" | "TT" | "TV" | "TW" | "TZ" | "UA" | "UG" | "US" | "UY" | "UZ" | "VA" | "VC" | "VE" | "VG" | "VN" | "VU" | "WF" | "WS" | "XK" | "YE" | "YT" | "ZA" | "ZM" | "ZW" | "ZZ")[]
}
export interface PaymentPagesCheckoutSessionShippingCost {
  /**
   * Total shipping cost before any discounts or taxes are applied.
   */
  amount_subtotal: number
  /**
   * Total tax amount applied due to shipping costs. If no tax was applied, defaults to 0.
   */
  amount_tax: number
  /**
   * Total shipping cost after discounts and taxes are applied.
   */
  amount_total: number
  /**
   * The ID of the ShippingRate for this order.
   */
  shipping_rate?: (string | ShippingRate | null)
  /**
   * The taxes applied to the shipping rate.
   */
  taxes?: LineItemsTaxAmount[]
}
export interface PaymentPagesCheckoutSessionShippingOption {
  /**
   * A non-negative integer in cents representing how much to charge.
   */
  shipping_amount: number
  /**
   * The shipping rate.
   */
  shipping_rate: (string | ShippingRate)
}
export interface PaymentPagesCheckoutSessionTaxIDCollection {
  /**
   * Indicates whether tax ID collection is enabled for the session
   */
  enabled: boolean
}
export interface PaymentPagesCheckoutSessionTotalDetails {
  /**
   * This is the sum of all the discounts.
   */
  amount_discount: number
  /**
   * This is the sum of all the shipping amounts.
   */
  amount_shipping?: (number | null)
  /**
   * This is the sum of all the tax amounts.
   */
  amount_tax: number
  breakdown?: PaymentPagesCheckoutSessionTotalDetailsResourceBreakdown
}
export interface PaymentPagesCheckoutSessionTotalDetailsResourceBreakdown {
  /**
   * The aggregated discounts.
   */
  discounts: LineItemsDiscountAmount[]
  /**
   * The aggregated tax amounts by rate.
   */
  taxes: LineItemsTaxAmount[]
}

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};
