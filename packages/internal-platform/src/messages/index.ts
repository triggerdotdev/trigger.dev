export type { MessageCatalogSchema } from "./messageCatalogSchema";

import coordinatorCatalog from "./catalogs/coordinator";
import platformCatalog from "./catalogs/platform";

type CoordinatorCatalog = typeof coordinatorCatalog;
type PlatformCatalog = typeof platformCatalog;

export type { CoordinatorCatalog, PlatformCatalog };
export { coordinatorCatalog, platformCatalog };
export * from "./zodPublisher";
export * from "./zodSubscriber";
export * from "./zodPubSub";
