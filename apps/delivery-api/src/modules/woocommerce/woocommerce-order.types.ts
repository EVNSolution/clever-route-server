export type WooCommerceMetaData = {
  key?: string | null;
  value?: unknown;
};

export type WooCommerceAddress = {
  address_1?: string | null;
  address_2?: string | null;
  city?: string | null;
  company?: string | null;
  country?: string | null;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  postcode?: string | null;
  state?: string | null;
};

export type WooCommerceLineItem = {
  id?: number | null;
  meta_data?: WooCommerceMetaData[] | null;
  name?: string | null;
  quantity?: number | null;
  sku?: string | null;
};

export type WooCommerceShippingLine = {
  meta_data?: WooCommerceMetaData[] | null;
  method_id?: string | null;
  method_title?: string | null;
};

export type WooCommerceOrder = {
  billing?: WooCommerceAddress | null;
  currency?: string | null;
  customer_note?: string | null;
  date_created?: string | null;
  date_created_gmt?: string | null;
  date_modified?: string | null;
  date_modified_gmt?: string | null;
  date_paid?: string | null;
  date_paid_gmt?: string | null;
  id: number;
  line_items?: WooCommerceLineItem[] | null;
  meta_data?: WooCommerceMetaData[] | null;
  number?: string | null;
  payment_method?: string | null;
  payment_method_title?: string | null;
  shipping?: WooCommerceAddress | null;
  shipping_lines?: WooCommerceShippingLine[] | null;
  status?: string | null;
  total?: string | null;
  transaction_id?: string | null;
};

export type WooCommerceOrderStatus =
  | 'pending'
  | 'processing'
  | 'on-hold'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'failed'
  | 'trash';
