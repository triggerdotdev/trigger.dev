import { Service } from "./service/types";

export type Catalog = {
  services: Record<string, Service>;
};
