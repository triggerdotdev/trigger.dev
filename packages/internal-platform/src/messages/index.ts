export type { MessageCatalogSchema } from "./messageCatalogSchema";

import wssCatalog from "./catalogs/wss";
import platformCatalog from "./catalogs/platform";

type WSSCatalog = typeof wssCatalog;
type PlatformCatalog = typeof platformCatalog;

export type { WSSCatalog, PlatformCatalog };
export { wssCatalog, platformCatalog };
export * from "./zodPublisher";
export * from "./zodSubscriber";
export * from "./zodPubSub";
