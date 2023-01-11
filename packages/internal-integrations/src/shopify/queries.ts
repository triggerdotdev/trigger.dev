import { gql } from "urql";

export const defaultFirst = 100;

export const searchProductVariantsQuery = gql`
  query SearchProductVariants($first: Int!, $filters: String) {
    productVariants(first: $first, query: $filters) {
      edges {
        node {
          id
          title
          createdAt
          updatedAt
          price
          product {
            id
            title
          }
          sku
          barcode
          compareAtPrice
          fulfillmentService {
            id
          }
          image {
            id
          }
          inventoryQuantity
          requiresShipping
          position
          taxCode
          taxable
          weight
          weightUnit
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export const createProductVariantsQuery = gql`
  mutation productVariantCreate($input: ProductVariantInput!) {
    productVariantCreate(input: $input) {
      productVariant {
        id
        title
        createdAt
        updatedAt
        price
        product {
          id
          title
        }
        sku
        barcode
        compareAtPrice
        fulfillmentService {
          id
        }
        image {
          id
        }
        inventoryQuantity
        requiresShipping
        position
        taxCode
        taxable
        weight
        weightUnit
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const createProductQuery = gql`
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id
        title
        status
        createdAt
        updatedAt
        description
        descriptionHtml
        featuredImage {
          id
        }
        handle
        hasOnlyDefaultVariant
        hasOutOfStockVariants
        images(first: 10) {
          edges {
            node {
              id
            }
          }
        }
        options {
          name
        }
        onlineStorePreviewUrl
        onlineStoreUrl
        priceRange {
          minVariantPrice {
            amount
          }
          maxVariantPrice {
            amount
          }
        }
        productType
        tags
        totalInventory
        totalVariants
        tracksInventory
        variants(first: 10) {
          edges {
            node {
              id
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;
