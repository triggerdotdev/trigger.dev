import { ExternalScriptsFunction } from "remix-utils";
import { BreadcrumbItem } from "~/components/navigation/Breadcrumb";

export type Handle = {
  breadcrumb?: BreadcrumbItem;
  expandSidebar?: boolean;
  scripts?: ExternalScriptsFunction;
};
