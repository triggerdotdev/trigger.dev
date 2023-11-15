import { EventSpecificationExample } from "@trigger.dev/sdk";

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

export const fulfillmentCreated: EventSpecificationExample = {
  id: "FulfillmentCreated",
  name: "Fulfillment created",
  payload: Fulfillment,
};
export const fulfillmentUpdated: EventSpecificationExample = {
  id: "FulfillmentUpdated",
  name: "Fulfillment updated",
  payload: Fulfillment,
};

export const inventoryItemCreated: EventSpecificationExample = {
  id: "InventoryItemCreated",
  name: "InventoryItem created",
  payload: InventoryItem,
};
export const inventoryItemDeleted: EventSpecificationExample = {
  id: "InventoryItemDeleted",
  name: "InventoryItem deleted",
  payload: InventoryItemDeleted,
};
export const inventoryItemUpdated: EventSpecificationExample = {
  id: "InventoryItemUpdated",
  name: "InventoryItem updated",
  payload: InventoryItem,
};

export const inventoryLevelCreated: EventSpecificationExample = {
  id: "InventoryLevelCreated",
  name: "InventoryLevel created",
  payload: InventoryLevel,
};
export const inventoryLevelDisconnected: EventSpecificationExample = {
  id: "InventoryLevelDisconnected",
  name: "InventoryLevel disconnected",
  payload: InventoryLevelDisconnected,
};
export const inventoryLevelUpdated: EventSpecificationExample = {
  id: "InventoryLevelUpdated",
  name: "InventoryLevel updated",
  payload: InventoryLevel,
};

export const localeCreated: EventSpecificationExample = {
  id: "LocaleCreated",
  name: "Locale created",
  payload: ShopLocale,
};
export const localeUpdated: EventSpecificationExample = {
  id: "LocaleUpdated",
  name: "Locale updated",
  payload: ShopLocale,
};

export const locationActivated: EventSpecificationExample = {
  id: "LocationActivated",
  name: "Location activated",
  payload: Location,
};
export const locationCreated: EventSpecificationExample = {
  id: "LocationCreated",
  name: "Location created",
  payload: Location,
};
export const locationDeactivated: EventSpecificationExample = {
  id: "LocationDeactivated",
  name: "Location deactivated",
  payload: Location,
};
export const locationDeleted: EventSpecificationExample = {
  id: "LocationDeleted",
  name: "Location deleted",
  payload: Deleted,
};
export const locationUpdated: EventSpecificationExample = {
  id: "LocationUpdated",
  name: "Location updated",
  payload: Location,
};

export const marketCreated: EventSpecificationExample = {
  id: "MarketCreated",
  name: "Market created",
  payload: Market,
};
export const marketDeleted: EventSpecificationExample = {
  id: "MarketDeleted",
  name: "Market deleted",
  payload: Deleted,
};
export const marketUpdated: EventSpecificationExample = {
  id: "MarketUpdated",
  name: "Market updated",
  payload: Market,
};

export const orderCreated: EventSpecificationExample = {
  id: "OrderCreated",
  name: "Order created",
  payload: Order,
};
export const orderDeleted: EventSpecificationExample = {
  id: "OrderDeleted",
  name: "Order deleted",
  payload: Deleted,
};
export const orderEdited: EventSpecificationExample = {
  id: "OrderEdited",
  name: "Order edited",
  payload: OrderEdited,
};
export const orderFulfilled: EventSpecificationExample = {
  id: "OrderFulfilled",
  name: "Order fulfilled",
  payload: Order,
};
export const orderPaid: EventSpecificationExample = {
  id: "OrderPaid",
  name: "Order paid",
  payload: Order,
};
export const orderPartiallyFulfilled: EventSpecificationExample = {
  id: "OrderPartiallyFulfilled",
  name: "Order partially fulfilled",
  payload: Order,
};
export const orderUpdated: EventSpecificationExample = {
  id: "OrderUpdated",
  name: "Order updated",
  payload: Order,
};

export const paymentScheduleDue: EventSpecificationExample = {
  id: "PaymentScheduleDue",
  name: "PaymentSchedule due",
  payload: PaymentSchedule,
};

export const productCreated: EventSpecificationExample = {
  id: "ProductCreated",
  name: "Product created",
  payload: Product,
};
export const productDeleted: EventSpecificationExample = {
  id: "ProductDeleted",
  name: "Product deleted",
  payload: Deleted,
};
export const productUpdated: EventSpecificationExample = {
  id: "ProductUpdated",
  name: "Product updated",
  payload: Product,
};

export const productListingCreated: EventSpecificationExample = {
  id: "ProductListingCreated",
  name: "ProductListing created",
  payload: ProductListing,
};
export const productListingRemoved: EventSpecificationExample = {
  id: "ProductListingRemoved",
  name: "ProductListing removed",
  payload: ProductListingRemoved,
};
export const productListingUpdated: EventSpecificationExample = {
  id: "ProductListingUpdated",
  name: "ProductListing updated",
  payload: ProductListing,
};

export const deliveryProfileAdded: EventSpecificationExample = {
  id: "DeliveryProfileAdded",
  name: "DeliveryProfile added",
  payload: DeliveryProfile,
};
export const deliveryProfileDeleted: EventSpecificationExample = {
  id: "DeliveryProfileDeleted",
  name: "DeliveryProfile deleted",
  payload: Deleted,
};
export const deliveryProfileUpdated: EventSpecificationExample = {
  id: "DeliveryProfileUpdated",
  name: "DeliveryProfile updated",
  payload: DeliveryProfile,
};

export const refundCreated: EventSpecificationExample = {
  id: "RefundCreated",
  name: "Refund created",
  payload: Refund,
};

export const sellingPlanGroupAdded: EventSpecificationExample = {
  id: "SellingPlanGroupAdded",
  name: "SellingPlanGroup added",
  payload: SellingPlanGroup,
};
export const sellingPlanGroupDeleted: EventSpecificationExample = {
  id: "SellingPlanGroupDeleted",
  name: "SellingPlanGroup deleted",
  payload: SellingPlanGroupDeleted,
};
export const sellingPlanGroupUpdated: EventSpecificationExample = {
  id: "SellingPlanGroupUpdated",
  name: "SellingPlanGroup updated",
  payload: SellingPlanGroup,
};

export const shopUpdated: EventSpecificationExample = {
  id: "ShopUpdated",
  name: "Shop updated",
  payload: Shop,
};

export const subscriptionBillingAttemptChallenged: EventSpecificationExample = {
  id: "SubscriptionBillingAttemptChallenged",
  name: "SubscriptionBillingAttempt challenged",
  payload: SubscriptionBillingAttempt,
};
export const subscriptionBillingAttemptFailure: EventSpecificationExample = {
  id: "SubscriptionBillingAttemptFailure",
  name: "SubscriptionBillingAttempt failure",
  payload: SubscriptionBillingAttempt,
};
export const subscriptionBillingAttemptSuccess: EventSpecificationExample = {
  id: "SubscriptionBillingAttemptSuccess",
  name: "SubscriptionBillingAttempt success",
  payload: SubscriptionBillingAttempt,
};

export const subscriptionBillingcycleCreated: EventSpecificationExample = {
  id: "SubscriptionBillingCycleCreated",
  name: "SubscriptionBillingCycle created",
  payload: SubscriptionBillingCycle,
};
export const subscriptionBillingcycleDeleted: EventSpecificationExample = {
  id: "SubscriptionBillingCycleDeleted",
  name: "SubscriptionBillingCycle deleted",
  payload: Deleted,
};
export const subscriptionBillingcycleUpdated: EventSpecificationExample = {
  id: "SubscriptionBillingCycleUpdated",
  name: "SubscriptionBillingCycle updated",
  payload: SubscriptionBillingCycle,
};

export const subscriptionContractCreated: EventSpecificationExample = {
  id: "SubscriptionContractCreated",
  name: "SubscriptionContract created",
  payload: SubscriptionContract,
};
export const subscriptionContractUpdated: EventSpecificationExample = {
  id: "SubscriptionContractUpdated",
  name: "SubscriptionContract updated",
  payload: SubscriptionContract,
};

export const tenderTransactionCreated: EventSpecificationExample = {
  id: "TenderTransactionCreated",
  name: "TenderTransaction created",
  payload: TenderTransaction,
};

export const themeCreated: EventSpecificationExample = {
  id: "ThemeCreated",
  name: "Theme created",
  payload: Theme,
};
export const themeDeleted: EventSpecificationExample = {
  id: "ThemeDeleted",
  name: "Theme deleted",
  payload: Deleted,
};
export const themePublished: EventSpecificationExample = {
  id: "ThemePublished",
  name: "Theme published",
  payload: Theme,
};
export const themeUpdated: EventSpecificationExample = {
  id: "ThemeUpdated",
  name: "Theme updated",
  payload: Theme,
};
