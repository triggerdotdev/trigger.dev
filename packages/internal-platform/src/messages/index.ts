export type { MessageCatalogSchema } from "./messageCatalogSchema";

import commandCatalog from "./catalogs/commands";
import commandResponseCatalog from "./catalogs/commandResponses";
import triggerCatalog from "./catalogs/triggers";

type CommandCatalog = typeof commandCatalog;
type CommandResponseCatalog = typeof commandResponseCatalog;
type TriggerCatalog = typeof triggerCatalog;

export type { CommandCatalog, CommandResponseCatalog, TriggerCatalog };
export { commandCatalog, commandResponseCatalog, triggerCatalog };
export * from "./zodPublisher";
export * from "./zodSubscriber";
export * from "./zodPubSub";
export * from "./zodEventSubscriber";
export * from "./zodEventPublisher";
