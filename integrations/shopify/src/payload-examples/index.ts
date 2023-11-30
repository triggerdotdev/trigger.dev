import { slugifyId, TypedEventSpecificationExample } from "@trigger.dev/sdk";

import AppUninstalled from "./AppUninstalled.json";
import AppSubscriptionsUpdate from "./AppSubscriptionsUpdate.json";
import BulkOperationsFinish from "./BulkOperationsFinish.json";
import CartsCreate from "./CartsCreate.json";
import CheckoutsCreate from "./CheckoutsCreate.json";
import CheckoutsDelete from "./CheckoutsDelete.json";
import CollectionListingsAdd from "./CollectionListingsAdd.json";
import CollectionListingsRemove from "./CollectionListingsRemove.json";
import CollectionsCreate from "./CollectionsCreate.json";
import CollectionsDelete from "./CollectionsDelete.json";
import CompaniesCreate from "./CompaniesCreate.json";
import CompanyContactsCreate from "./CompanyContactsCreate.json";
import CompanyLocationsCreate from "./CompanyLocationsCreate.json";
import CustomerGroupsCreate from "./CustomerGroupsCreate.json";
import CustomerPaymentMethodsCreate from "./CustomerPaymentMethodsCreate.json";
import CustomersCreate from "./CustomersCreate.json";
import CustomersDelete from "./CustomersDelete.json";
import CustomersMerge from "./CustomersMerge.json";
import CustomersEmailMarketingConsentUpdate from "./CustomersEmailMarketingConsentUpdate.json";
import CustomersMarketingConsentUpdate from "./CustomersMarketingConsentUpdate.json";
import DisputesCreate from "./DisputesCreate.json";
import DomainsCreate from "./DomainsCreate.json";
import DraftOrdersCreate from "./DraftOrdersCreate.json";
import DraftOrdersDelete from "./DraftOrdersDelete.json";
import FulfillmentEventsCreate from "./FulfillmentEventsCreate.json";
import FulfillmentOrdersCancellationRequestAccepted from "./FulfillmentOrdersCancellationRequestAccepted.json";
import FulfillmentOrdersCancellationRequestRejected from "./FulfillmentOrdersCancellationRequestRejected.json";
import FulfillmentOrdersCancellationRequestSubmitted from "./FulfillmentOrdersCancellationRequestSubmitted.json";
import FulfillmentOrdersCancelled from "./FulfillmentOrdersCancelled.json";
import FulfillmentOrdersFulfillmentRequestAccepted from "./FulfillmentOrdersFulfillmentRequestAccepted.json";
import FulfillmentOrdersFulfillmentRequestRejected from "./FulfillmentOrdersFulfillmentRequestRejected.json";
import FulfillmentOrdersFulfillmentRequestSubmitted from "./FulfillmentOrdersFulfillmentRequestSubmitted.json";
import FulfillmentOrdersFulfillmentServiceFailedToComplete from "./FulfillmentOrdersFulfillmentServiceFailedToComplete.json";
import FulfillmentOrdersHoldReleased from "./FulfillmentOrdersHoldReleased.json";
import FulfillmentOrdersLineItemsPreparedForLocalDelivery from "./FulfillmentOrdersLineItemsPreparedForLocalDelivery.json";
import FulfillmentOrdersLineItemsPreparedForPickup from "./FulfillmentOrdersLineItemsPreparedForPickup.json";
import FulfillmentOrdersMoved from "./FulfillmentOrdersMoved.json";
import FulfillmentOrdersOrderRoutingComplete from "./FulfillmentOrdersOrderRoutingComplete.json";
import FulfillmentOrdersPlacedOnHold from "./FulfillmentOrdersPlacedOnHold.json";
import FulfillmentOrdersRescheduled from "./FulfillmentOrdersRescheduled.json";
import FulfillmentOrdersScheduledFulfillmentOrderReady from "./FulfillmentOrdersScheduledFulfillmentOrderReady.json";
import OrderTransactionsCreate from "./OrderTransactionsCreate.json";
import ProductFeedsCreate from "./ProductFeedsCreate.json";
import ProductFeedsFullSync from "./ProductFeedsFullSync.json";
import ProductFeedsIncrementalSync from "./ProductFeedsIncrementalSync.json";
import ScheduledProductListingsAdd from "./ScheduledProductListingsAdd.json";
import ScheduledProductListingsRemove from "./ScheduledProductListingsRemove.json";
import Deleted from "./Deleted.json";
import DeliveryProfile from "./DeliveryProfile.json";
import Fulfillment from "./Fulfillment.json";
import InventoryItem from "./InventoryItem.json";
import InventoryItemDeleted from "./InventoryItemDeleted.json";
import InventoryLevel from "./InventoryLevel.json";
import InventoryLevelDisconnected from "./InventoryLevelDisconnected.json";
import Location from "./Location.json";
import Market from "./Market.json";
import Order from "./Order.json";
import OrderEdited from "./OrderEdited.json";
import PaymentSchedule from "./PaymentSchedule.json";
import Product from "./Product.json";
import ProductListing from "./ProductListing.json";
import ProductListingRemoved from "./ProductListingRemoved.json";
import Refund from "./Refund.json";
import SellingPlanGroup from "./SellingPlanGroup.json";
import SellingPlanGroupDeleted from "./SellingPlanGroupDeleted.json";
import Shop from "./Shop.json";
import ShopLocale from "./ShopLocale.json";
import SubscriptionBillingAttempt from "./SubscriptionBillingAttempt.json";
import SubscriptionBillingCycle from "./SubscriptionBillingCycle.json";
import SubscriptionContract from "./SubscriptionContract.json";
import TenderTransaction from "./TenderTransaction.json";
import Theme from "./Theme.json";

const example = <TEvent>(name: string, payload: TEvent): TypedEventSpecificationExample<TEvent> => {
  return {
    id: slugifyId(name),
    name,
    payload,
  };
};

export const shopifyPayloads = {
  "app/uninstalled": AppUninstalled,
  "app_subscriptions/update": AppSubscriptionsUpdate,
  "bulk_operations/finish": BulkOperationsFinish,
  "carts/create": CartsCreate,
  "carts/update": CartsCreate,
  "checkouts/create": CheckoutsCreate,
  "checkouts/delete": CheckoutsDelete,
  "checkouts/update": CheckoutsCreate,
  "collection_listings/add": CollectionListingsAdd,
  "collection_listings/remove": CollectionListingsRemove,
  "collection_listings/update": CollectionListingsAdd,
  "collections/create": CollectionsCreate,
  "collections/delete": CollectionsDelete,
  "collections/update": CollectionsCreate,
  "companies/create": CompaniesCreate,
  "companies/delete": CompaniesCreate,
  "companies/update": CompaniesCreate,
  "company_contact_roles/assign": {},
  "company_contact_roles/revoke": {},
  "company_contacts/create": CompanyContactsCreate,
  "company_contacts/delete": CompanyContactsCreate,
  "company_contacts/update": CompanyContactsCreate,
  "company_locations/create": CompanyLocationsCreate,
  "company_locations/delete": CompanyLocationsCreate,
  "company_locations/update": CompanyLocationsCreate,
  "customer_groups/create": CustomerGroupsCreate,
  "customer_groups/delete": Deleted,
  "customer_groups/update": CustomerGroupsCreate,
  "customer_payment_methods/create": CustomerPaymentMethodsCreate,
  "customer_payment_methods/revoke": CustomerPaymentMethodsCreate,
  "customer_payment_methods/update": CustomerPaymentMethodsCreate,
  "customers/create": CustomersCreate,
  "customers/delete": CustomersDelete,
  "customers/disable": CustomersCreate,
  "customers/enable": CustomersCreate,
  "customers/merge": CustomersMerge,
  "customers/update": CustomersCreate,
  "customers_email_marketing_consent/update": CustomersEmailMarketingConsentUpdate,
  "customers_marketing_consent/update": CustomersMarketingConsentUpdate,
  "disputes/create": DisputesCreate,
  "disputes/update": DisputesCreate,
  "domains/create": DomainsCreate,
  "domains/destroy": DomainsCreate,
  "domains/update": DomainsCreate,
  "draft_orders/create": DraftOrdersCreate,
  "draft_orders/delete": DraftOrdersDelete,
  "draft_orders/update": DraftOrdersCreate,
  "fulfillment_events/create": FulfillmentEventsCreate,
  "fulfillment_events/delete": FulfillmentEventsCreate,
  "fulfillment_orders/cancellation_request_accepted": FulfillmentOrdersCancellationRequestAccepted,
  "fulfillment_orders/cancellation_request_rejected": FulfillmentOrdersCancellationRequestRejected,
  "fulfillment_orders/cancellation_request_submitted":
    FulfillmentOrdersCancellationRequestSubmitted,
  "fulfillment_orders/cancelled": FulfillmentOrdersCancelled,
  "fulfillment_orders/fulfillment_request_accepted": FulfillmentOrdersFulfillmentRequestAccepted,
  "fulfillment_orders/fulfillment_request_rejected": FulfillmentOrdersFulfillmentRequestRejected,
  "fulfillment_orders/fulfillment_request_submitted": FulfillmentOrdersFulfillmentRequestSubmitted,
  "fulfillment_orders/fulfillment_service_failed_to_complete":
    FulfillmentOrdersFulfillmentServiceFailedToComplete,
  "fulfillment_orders/hold_released": FulfillmentOrdersHoldReleased,
  "fulfillment_orders/line_items_prepared_for_local_delivery":
    FulfillmentOrdersLineItemsPreparedForLocalDelivery,
  "fulfillment_orders/line_items_prepared_for_pickup": FulfillmentOrdersLineItemsPreparedForPickup,
  "fulfillment_orders/moved": FulfillmentOrdersMoved,
  "fulfillment_orders/order_routing_complete": FulfillmentOrdersOrderRoutingComplete,
  "fulfillment_orders/placed_on_hold": FulfillmentOrdersPlacedOnHold,
  "fulfillment_orders/rescheduled": FulfillmentOrdersRescheduled,
  "fulfillment_orders/scheduled_fulfillment_order_ready":
    FulfillmentOrdersScheduledFulfillmentOrderReady,
  "fulfillments/create": Fulfillment,
  "fulfillments/update": Fulfillment,
  "inventory_items/create": InventoryItem,
  "inventory_items/delete": InventoryItemDeleted,
  "inventory_items/update": InventoryItem,
  "inventory_levels/connect": InventoryLevel,
  "inventory_levels/disconnect": InventoryLevelDisconnected,
  "inventory_levels/update": InventoryLevel,
  "locales/create": ShopLocale,
  "locales/update": ShopLocale,
  "locations/activate": Location,
  "locations/create": Location,
  "locations/deactivate": Location,
  "locations/delete": Deleted,
  "locations/update": Location,
  "markets/create": Market,
  "markets/delete": Deleted,
  "markets/update": Market,
  "order_transactions/create": OrderTransactionsCreate,
  "orders/cancelled": Order,
  "orders/create": Order,
  "orders/delete": Deleted,
  "orders/edited": OrderEdited,
  "orders/fulfilled": Order,
  "orders/paid": Order,
  "orders/partially_fulfilled": Order,
  "orders/updated": Order,
  "payment_schedules/due": PaymentSchedule,
  "product_feeds/create": ProductFeedsCreate,
  "product_feeds/full_sync": ProductFeedsFullSync,
  "product_feeds/incremental_sync": ProductFeedsIncrementalSync,
  "product_listings/add": ProductListing,
  "product_listings/remove": ProductListingRemoved,
  "product_listings/update": ProductListing,
  "products/create": Product,
  "products/delete": Deleted,
  "products/update": Product,
  "profiles/create": DeliveryProfile,
  "profiles/delete": Deleted,
  "profiles/update": DeliveryProfile,
  "refunds/create": Refund,
  "scheduled_product_listings/add": ScheduledProductListingsAdd,
  "scheduled_product_listings/remove": ScheduledProductListingsRemove,
  "scheduled_product_listings/update": ScheduledProductListingsAdd,
  "selling_plan_groups/create": SellingPlanGroup,
  "selling_plan_groups/delete": SellingPlanGroupDeleted,
  "selling_plan_groups/update": SellingPlanGroup,
  "shop/update": Shop,
  "subscription_billing_attempts/challenged": SubscriptionBillingAttempt,
  "subscription_billing_attempts/failure": SubscriptionBillingAttempt,
  "subscription_billing_attempts/success": SubscriptionBillingAttempt,
  "subscription_billing_cycle_edits/create": SubscriptionBillingCycle,
  "subscription_billing_cycle_edits/delete": Deleted,
  "subscription_billing_cycle_edits/update": SubscriptionBillingCycle,
  "subscription_contracts/create": SubscriptionContract,
  "subscription_contracts/update": SubscriptionContract,
  "tender_transactions/create": TenderTransaction,
  "themes/create": Theme,
  "themes/delete": Deleted,
  "themes/publish": Theme,
  "themes/update": Theme,
};

export type ShopifyPayloads = typeof shopifyPayloads;

export const shopifyExample = <TName extends keyof ShopifyPayloads>(
  name: TName
): TypedEventSpecificationExample<ShopifyPayloads[TName]> => example(name, shopifyPayloads[name]);

export type ShopifyExamples = typeof shopifyExample;
