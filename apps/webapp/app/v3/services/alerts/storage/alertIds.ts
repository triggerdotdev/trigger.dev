import { generateFriendlyId } from "~/v3/friendlyIdentifiers";

export const generateAlertId = () => generateFriendlyId("alert");
export const generateAlertEventId = () => generateFriendlyId("aevt");
export const generateAlertDeliveryId = () => generateFriendlyId("adel");
export const generateAlertDeliveryClaimId = () => generateFriendlyId("adc");
