import type { MultipartValue } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';

import { WooCommerceOnboardingError } from '../modules/commerce/woocommerce-connection-onboarding.service.js';

const DEFAULT_MAX_FIELDS = 8;

export async function readAdminUiFormFields(
  request: FastifyRequest,
  options: { allowedFields: readonly string[]; maxFields?: number }
): Promise<Record<string, string>> {
  if (!request.isMultipart()) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Admin UI form must be multipart/form-data', 400);
  }

  const allowed = new Set(options.allowedFields);
  const output: Record<string, string> = {};
  let fields = 0;

  try {
    for await (const part of request.parts({
      limits: {
        fields: options.maxFields ?? DEFAULT_MAX_FIELDS,
        files: 1,
        parts: (options.maxFields ?? DEFAULT_MAX_FIELDS) + 1
      }
    })) {
      if (part.type === 'file') {
        throw new WooCommerceOnboardingError('BAD_REQUEST', 'File uploads are not accepted by this admin form', 400);
      }
      fields += 1;
      if (fields > (options.maxFields ?? DEFAULT_MAX_FIELDS)) {
        throw new WooCommerceOnboardingError('BAD_REQUEST', 'Admin UI form has too many fields', 400);
      }
      if (!allowed.has(part.fieldname)) {
        throw new WooCommerceOnboardingError('BAD_REQUEST', 'Admin UI form contains an unexpected field', 400);
      }
      if (Object.prototype.hasOwnProperty.call(output, part.fieldname)) {
        throw new WooCommerceOnboardingError('BAD_REQUEST', 'Admin UI form contains a duplicate field', 400);
      }
      output[part.fieldname] = readMultipartFieldValue(part);
    }
  } catch (error) {
    if (error instanceof WooCommerceOnboardingError) throw error;
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Admin UI form is invalid', 400);
  }

  return output;
}

function readMultipartFieldValue(field: MultipartValue): string {
  if (typeof field.value !== 'string') {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Admin UI form field must be a string', 400);
  }
  if (field.valueTruncated) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'Admin UI form field is too large', 400);
  }
  return field.value;
}
