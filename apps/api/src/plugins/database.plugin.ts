import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { createPrismaClient, type PrismaClient } from "@bam/db";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export interface DatabasePluginOptions {
  databaseUrl: string;
  logQueries?: boolean;
}

/**
 * Owns the Prisma client's lifecycle.
 *
 * Note it does not connect eagerly: Prisma connects lazily on first query, and
 * a database that is briefly unreachable should surface as a failing
 * `/health/ready` rather than as a process that refuses to start. A crash-loop
 * during a database blip helps nobody (CLAUDE.md rule 4).
 */
const databasePlugin: FastifyPluginAsync<DatabasePluginOptions> = async (app, options) => {
  const prisma = createPrismaClient({
    databaseUrl: options.databaseUrl,
    ...(options.logQueries === undefined ? {} : { logQueries: options.logQueries }),
  });

  app.decorate("prisma", prisma);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
};

export default fp(databasePlugin, { name: "database" });
