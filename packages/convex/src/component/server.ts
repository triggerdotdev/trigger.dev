import {
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
  type ActionBuilder,
  type MutationBuilder,
  type QueryBuilder,
  type DataModelFromSchemaDefinition,
} from "convex/server";
import type schema from "./schema.js";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export const mutation: MutationBuilder<DataModel, "public"> = mutationGeneric;
export const query: QueryBuilder<DataModel, "public"> = queryGeneric;
export const internalMutation: MutationBuilder<DataModel, "internal"> = internalMutationGeneric;
export const internalQuery: QueryBuilder<DataModel, "internal"> = internalQueryGeneric;
export const internalAction: ActionBuilder<DataModel, "internal"> = internalActionGeneric;
