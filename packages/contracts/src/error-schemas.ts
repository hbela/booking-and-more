import { z } from "zod";
import { ErrorCodes } from "./error-codes.js";

/**
 * Zod mirror of the error envelope, so routes can declare it in their `response`
 * map and it shows up in the OpenAPI document. tech-impl §15.1.
 */
export const errorCodeSchema = z.enum(Object.values(ErrorCodes) as [string, ...string[]]);

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

/**
 * Attach to every route's `response` map so failures are documented, not just
 * the happy path.
 *
 * ```ts
 * schema: { response: { 200: fooSchema, ...commonErrorResponses } }
 * ```
 */
export const commonErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  422: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  500: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
} as const;
