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
import { slugifyId } from "@trigger.dev/sdk/utils";

const example = (name: string, payload: any): EventSpecificationExample => {
  return {
    id: slugifyId(name),
    name,
    payload,
  };
};

export const fulfillmentCreated = example("Fulfillment created", Fulfillment);
export const fulfillmentUpdated = example("Fulfillment updated", Fulfillment);

export const inventoryItemCreated = example("InventoryItem created", InventoryItem);
export const inventoryItemDeleted = example("InventoryItem deleted", InventoryItemDeleted);
export const inventoryItemUpdated = example("InventoryItem updated", InventoryItem);

export const inventoryLevelConnected = example("InventoryLevel connected", InventoryLevel);
export const inventoryLevelDisconnected = example(
  "InventoryLevel disconnected",
  InventoryLevelDisconnected
);
export const inventoryLevelUpdated = example("InventoryLevel updated", InventoryLevel);

export const localeCreated = example("Locale created", ShopLocale);
export const localeUpdated = example("Locale updated", ShopLocale);

export const locationActivated = example("Location activated", Location);
export const locationCreated = example("Location created", Location);
export const locationDeactivated = example("Location deactivated", Location);
export const locationDeleted = example("Location deleted", Deleted);
export const locationUpdated = example("Location updated", Location);

export const marketCreated = example("Market created", Market);
export const marketDeleted = example("Market deleted", Deleted);
export const marketUpdated = example("Market updated", Market);

export const orderCancelled = example("Order cancelled", Order);
export const orderCreated = example("Order created", Order);
export const orderDeleted = example("Order deleted", Deleted);
export const orderEdited = example("Order edited", OrderEdited);
export const orderFulfilled = example("Order fulfilled", Order);
export const orderPaid = example("Order paid", Order);
export const orderPartiallyFulfilled = example("Order partially fulfilled", Order);
export const orderUpdated = example("Order updated", Order);

export const paymentScheduleDue = example("PaymentSchedule due", PaymentSchedule);

export const productCreated = example("Product created", Product);
export const productDeleted = example("Product deleted", Deleted);
export const productUpdated = example("Product updated", Product);

export const productlistingAdded = example("ProductListing added", ProductListing);
export const productListingRemoved = example("ProductListing removed", ProductListingRemoved);
export const productListingUpdated = example("ProductListing updated", ProductListing);

export const deliveryProfileCreated = example("DeliveryProfile created", DeliveryProfile);
export const deliveryProfileDeleted = example("DeliveryProfile deleted", Deleted);
export const deliveryProfileUpdated = example("DeliveryProfile updated", DeliveryProfile);

export const refundCreated = example("Refund created", Refund);

export const sellingPlanGroupCreated = example("SellingPlanGroup created", SellingPlanGroup);
export const sellingPlanGroupDeleted = example("SellingPlanGroup deleted", SellingPlanGroupDeleted);
export const sellingPlanGroupUpdated = example("SellingPlanGroup updated", SellingPlanGroup);

export const shopUpdated = example("Shop updated", Shop);

export const subscriptionBillingAttemptChallenged = example(
  "SubscriptionBillingAttempt challenged",
  SubscriptionBillingAttempt
);
export const subscriptionBillingAttemptFailure = example(
  "SubscriptionBillingAttempt failure",
  SubscriptionBillingAttempt
);
export const subscriptionBillingAttemptSuccess = example(
  "SubscriptionBillingAttempt success",
  SubscriptionBillingAttempt
);

export const subscriptionBillingCycleCreated = example(
  "SubscriptionBillingCycle created",
  SubscriptionBillingCycle
);
export const subscriptionBillingCycleDeleted = example("SubscriptionBillingCycle deleted", Deleted);
export const subscriptionBillingCycleUpdated = example(
  "SubscriptionBillingCycle updated",
  SubscriptionBillingCycle
);

export const subscriptionContractCreated = example(
  "SubscriptionContract created",
  SubscriptionContract
);
export const subscriptionContractUpdated = example(
  "SubscriptionContract updated",
  SubscriptionContract
);

export const tenderTransactionCreated = example("TenderTransaction created", TenderTransaction);

export const themeCreated = example("Theme created", Theme);
export const themeDeleted = example("Theme deleted", Deleted);
export const themePublished = example("Theme published", Theme);
export const themeUpdated = example("Theme updated", Theme);
