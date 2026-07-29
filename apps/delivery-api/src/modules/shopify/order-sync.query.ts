import type { ShopifyAdminGraphqlRequest } from './admin-graphql.client.js';

export type BuildOrdersUpdatedSinceQueryInput = {
  after?: string | null;
  first: number;
  updatedSince: Date;
};

export function buildOrdersUpdatedSinceQuery(
  input: BuildOrdersUpdatedSinceQueryInput
): ShopifyAdminGraphqlRequest {
  return {
    query: ORDERS_UPDATED_SINCE_QUERY,
    variables: {
      after: input.after ?? null,
      first: input.first,
      query: `updated_at:>='${input.updatedSince.toISOString()}'`
    }
  };
}

export function buildOrderByIdQuery(input: { id: string }): ShopifyAdminGraphqlRequest {
  return {
    query: ORDER_BY_ID_QUERY,
    variables: { id: input.id }
  };
}

const ORDER_FIELDS = `#graphql
        id
        legacyResourceId
        name
        phone
        displayFinancialStatus
        paymentGatewayNames
        displayFulfillmentStatus
        createdAt
        processedAt
        updatedAt
        cancelledAt
        note
        tags
        customAttributes {
          key
          value
        }
        lineItems(first: 20) {
          nodes {
            title
            name
            variantTitle
            quantity
            sku
          }
        }
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        shippingAddress {
          name
          phone
          address1
          address2
          city
          province
          provinceCode
          zip
          countryCodeV2
          latitude
          longitude
        }
`;

export const ORDERS_UPDATED_SINCE_QUERY = `#graphql
  query CleverDeliveryOrdersUpdatedSince($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes {
${ORDER_FIELDS}      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

export const ORDER_BY_ID_QUERY = `#graphql
  query CleverDeliveryOrderById($id: ID!) {
    node(id: $id) {
      ... on Order {
${ORDER_FIELDS}      }
    }
  }
`;
