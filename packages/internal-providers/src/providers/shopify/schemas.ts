import { z } from "zod";
import { parseGid } from "@shopify/admin-graphql-api-utilities";

export const FirstOrLastSchema = z
  .object({
    first: z.number().optional(),
  })
  .default({ first: 100 });

const objectWithId = z.object({
  id: z.string(),
});

export const ProductVariantSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  price: z.string().nullable(),
  product: z.object({
    id: z.string(),
    title: z.string(),
  }),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  compareAtPrice: z.string().nullable(),
  fulfillmentService: objectWithId.nullable(),
  image: objectWithId.nullable(),
  inventoryQuantity: z.number().nullable(),
  requiresShipping: z.boolean().nullable(),
  position: z.number().nullable(),
  taxCode: z.string().nullable(),
  taxable: z.boolean().nullable(),
  weight: z.number().nullable(),
  weightUnit: z.string().nullable(),
});

export const SearchVariantsBodySchema = FirstOrLastSchema.and(
  z.object({
    filter: z
      .object({
        productId: z.array(z.string().transform((s) => parseGid(s))).optional(),
        sku: z.array(z.string()).optional(),
      })
      .optional(),
  })
);

export const SearchVariantsSuccessResponseSchema = z.object({
  count: z.number(),
  productVariants: z.array(ProductVariantSchema),
});

const InventoryQuantitySchema = z.object({
  availableQuantity: z.number(),
  locationId: z.string(),
});

const InventoryItemSchema = z.object({
  cost: z.string().optional(),
  tracked: z.boolean().optional(),
});

const InventoryPolicy = z.union([z.literal("CONTINUE"), z.literal("DENY")]);

export const CreateVariantBodySchema = z.object({
  productId: z.string(),
  options: z.array(z.string()),
  price: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  compareAtPrice: z.string().optional(),
  inventoryItem: InventoryItemSchema.optional(),
  inventoryPolicy: InventoryPolicy.optional(),
  inventoryQuantities: z.array(InventoryQuantitySchema).optional(),
  requiresShipping: z.boolean().optional(),
  position: z.number().optional(),
  taxCode: z.string().optional(),
  taxable: z.boolean().optional(),
  weight: z.number().optional(),
  weightUnit: z.string().optional(),
});
