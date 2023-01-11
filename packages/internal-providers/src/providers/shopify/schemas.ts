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

const ProductStatusSchema = z.union([
  z.literal("ACTIVE"),
  z.literal("ARCHIVED"),
  z.literal("DRAFT"),
]);

export const ProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: ProductStatusSchema,
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  description: z.string().nullable(),
  descriptionHtml: z.string().nullable(),
  featuredImage: objectWithId.nullable(),
  handle: z.string().nullable(),
  hasOnlyDefaultVariant: z.boolean().nullable(),
  hasOutOfStockVariants: z.boolean().nullable(),
  options: z.array(z.object({ name: z.string() })).nullable(),
  onlineStorePreviewUrl: z.string().nullable(),
  onlineStoreUrl: z.string().nullable(),
  priceRange: z
    .object({
      maxVariantPrice: z.object({ amount: z.string() }),
      minVariantPrice: z.object({ amount: z.string() }),
    })
    .nullable(),
  productType: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  totalInventory: z.number().nullable(),
  totalVariants: z.number().nullable(),
  tracksInventory: z.boolean().nullable(),
  variants: z.array(objectWithId).nullable(),
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

export const CreateProductBodySchema = z.object({
  title: z.string(),
  collectionsToJoin: z.array(z.string()).optional(),
  customProductType: z.string().optional(),
  descriptionHtml: z.string().optional(),
  giftCard: z.boolean().optional(),
  giftCardTemplateSuffix: z.string().optional(),
  handle: z.string().optional(),
  options: z.array(z.string()).optional(),
  productType: z.string().optional(),
  requiresSellingPlan: z.boolean().optional(),
  seo: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  standardizedProductType: z
    .object({
      productTaxonomyNodeId: z.string(),
    })
    .optional(),
  status: ProductStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  templateSuffix: z.string().optional(),
  variants: z
    .array(CreateVariantBodySchema.omit({ productId: true }))
    .optional(),
  vendor: z.string().optional(),
});
