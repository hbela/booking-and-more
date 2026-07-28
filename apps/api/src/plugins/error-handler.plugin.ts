import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { ErrorCodes, InternalError, isAppError, type ErrorEnvelope } from "@bam/contracts";
import { captureException } from "@bam/observability";

/**
 * Turns every failure into the standard envelope (tech-impl §15.1):
 *
 *   { error: { code, message, requestId, details } }
 *
 * The important property is the default branch: anything that is not an
 * AppError is a bug, and is reported as a bare 500 with no internal detail
 * leaked to the caller. Stack traces, driver messages and connection strings
 * stay in the logs.
 */
const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.context?.requestId ?? "unknown";

    // --- Request failed schema validation ----------------------------------
    if (hasZodFastifySchemaValidationErrors(error)) {
      const envelope: ErrorEnvelope = {
        error: {
          code: ErrorCodes.VALIDATION_FAILED,
          message: "The request payload is invalid.",
          requestId,
          details: {
            issues: error.validation.map((issue) => ({
              path: issue.instancePath,
              message: issue.message,
            })),
          },
        },
      };

      request.log.info({ err: error, validation: error.validation }, "request validation failed");
      return reply.status(422).send(envelope);
    }

    // --- The handler returned something the response schema rejects ---------
    // This is our bug, not the caller's: a 500, and it must be loud. Silently
    // shipping an off-contract response is how clients start depending on
    // undocumented fields.
    if (isResponseSerializationError(error)) {
      request.log.error(
        { err: error, method: error.method, url: error.url },
        "response failed its own schema — handler and contract disagree",
      );
      captureException(error, { requestId, method: error.method, url: error.url });

      return reply.status(500).send({
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: "An unexpected error occurred.",
          requestId,
        },
      } satisfies ErrorEnvelope);
    }

    // --- A Zod error thrown from inside a service --------------------------
    if (error instanceof ZodError) {
      request.log.info({ err: error }, "domain validation failed");
      return reply.status(422).send({
        error: {
          code: ErrorCodes.VALIDATION_FAILED,
          message: "The request payload is invalid.",
          requestId,
          details: {
            issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        },
      } satisfies ErrorEnvelope);
    }

    // --- A deliberate application error ------------------------------------
    if (isAppError(error)) {
      const envelope: ErrorEnvelope = {
        error: { ...error.toPayload(), requestId },
      };

      if (error.report) {
        request.log.error({ err: error }, error.message);
        captureException(error, { requestId });
      } else {
        // Expected 4xx: worth a line for debugging, not worth paging anyone.
        request.log.info({ err: error }, error.message);
      }

      return reply.status(error.statusCode).send(envelope);
    }

    // --- Fastify's own errors (body too large, unsupported media type, ...) --
    // Read through a structural type: the guards above have narrowed `error`
    // away from FastifyError, so its own properties are no longer visible.
    const raw = error as { statusCode?: number; message?: string };
    const fastifyStatus = typeof raw.statusCode === "number" ? raw.statusCode : undefined;

    if (fastifyStatus !== undefined && fastifyStatus >= 400 && fastifyStatus < 500) {
      request.log.info({ err: error }, "client error");
      return reply.status(fastifyStatus).send({
        error: {
          code: fastifyStatus === 429 ? ErrorCodes.RATE_LIMITED : ErrorCodes.VALIDATION_FAILED,
          message: raw.message ?? "The request could not be processed.",
          requestId,
        },
      } satisfies ErrorEnvelope);
    }

    // --- Anything else is a bug --------------------------------------------
    const internal = new InternalError("An unexpected error occurred.", error);
    request.log.error({ err: error }, "unhandled error");
    captureException(error, { requestId });

    return reply.status(500).send({
      error: { ...internal.toPayload(), requestId },
    } satisfies ErrorEnvelope);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: ErrorCodes.NOT_FOUND,
        message: `Route ${request.method} ${request.url} does not exist.`,
        requestId: request.context?.requestId ?? "unknown",
      },
    } satisfies ErrorEnvelope),
  );
};

export default fp(errorHandlerPlugin, { name: "error-handler", dependencies: ["request-context"] });
