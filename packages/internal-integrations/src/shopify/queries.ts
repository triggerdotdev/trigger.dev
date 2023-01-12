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

export const appendProductImagesQuery = gql`
  mutation productAppendImages($input: ProductAppendImagesInput!) {
    productAppendImages(input: $input) {
      newImages {
        id
        altText
        url
        height
        width
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const listCollectionsQuery = gql`
  query ListCollections($first: Int!, $filters: String) {
    collections(first: $first, query: $filters) {
      edges {
        node {
          id
          title
          handle
          updatedAt
          productsCount
          sortOrder
        }
      }
    }
  }
`;

export const listLocationsQuery = gql`
  query ListLocations($first: Int!) {
    locations(first: $first) {
      edges {
        node {
          id
          name
          isActive
        }
      }
    }
  }
`;

export const addProductsToCollectionQuery = gql`
  mutation collectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection {
        id
        title
        productsCount
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const updateProductQuery = gql`
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
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
