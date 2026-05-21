#!/usr/bin/env node
import crypto from 'node:crypto';

const baseUrl = process.env.WC_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:8088';
const consumerKey = process.env.WC_CONSUMER_KEY;
const consumerSecret = process.env.WC_CONSUMER_SECRET;

if (!consumerKey || !consumerSecret) {
  console.error('WC_CONSUMER_KEY and WC_CONSUMER_SECRET are required.');
  process.exit(2);
}

const endpoint = `${baseUrl}/wp-json/wc/v3/orders`;
const params = {
  oauth_consumer_key: consumerKey,
  oauth_nonce: crypto.randomBytes(16).toString('hex'),
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  per_page: '1'
};
const encode = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const parameterString = Object.keys(params)
  .sort()
  .map((key) => `${encode(key)}=${encode(params[key])}`)
  .join('&');
const signatureBaseString = ['GET', encode(endpoint), encode(parameterString)].join('&');
params.oauth_signature = crypto
  .createHmac('sha1', `${encode(consumerSecret)}&`)
  .update(signatureBaseString)
  .digest('base64');
const query = Object.keys(params)
  .sort()
  .map((key) => `${encode(key)}=${encode(params[key])}`)
  .join('&');

console.log(`${endpoint}?${query}`);
