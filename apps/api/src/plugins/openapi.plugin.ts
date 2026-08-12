import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

export interface OpenApiPluginOptions {
  apiBaseUrl: string;
  /** Serve the interactive reference. Off in production. */
  exposeUi: boolean;
}

/**
 * OpenAPI document generated from the routes' Zod schemas.
 *
 * This is only as good as the schemas: because `jsonSchemaTransform` reads the
 * route `schema` object, a route that omits it contributes an empty shell. That
 * is precisely how the predecessor project ended up with a committed 240 KB
 * openapi.json that documented nothing — hence CLAUDE.md rule 2.
 */
const openApiPlugin: FastifyPluginAsync<OpenApiPluginOptions> = async (app, options) => {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "booking-and-more API",
        description:
          "Multi-tenant booking platform. The public booking form and the staff dashboard call the same deterministic booking engine.",
        version: "0.1.0",
      },
      servers: [{ url: options.apiBaseUrl }],
      tags: [
        { name: "health", description: "Liveness and readiness" },
        { name: "public", description: "Unauthenticated booking endpoints" },
        { name: "staff", description: "Authenticated dashboard endpoints" },
      ],
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "bam.session" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  if (options.exposeUi) {
    // @scalar/fastify-api-reference ships plugin types that do not line up with
    // Fastify 5's generics. The registration is correct at runtime; only the
    // declaration is imprecise.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await app.register(scalar, {
      routePrefix: "/docs",
      configuration: { title: "booking-and-more API" },
    });
  }
};

export default fp(openApiPlugin, { name: "openapi" });
