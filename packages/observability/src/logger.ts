import { pino, type Logger, type LoggerOptions } from "pino";
import { REDACT_PATHS, REDACTED } from "./redaction.js";

/**
 * Context attached to every log line. tech-impl §36.1.
 *
 * Populated by the API's request-context plugin and carried through
 * AsyncLocalStorage, so a log call deep in a service does not need to thread
 * these through by hand.
 */
export interface LogContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  bookingId?: string;
  module?: string;
}

export interface CreateLoggerOptions {
  /** Appears as `service` on every line: "api" | "worker" | "web". */
  service: string;
  level?: string;
  /** Human-readable output via pino-pretty. Development only. */
  pretty?: boolean;
  /** Extra static fields merged into the base. */
  base?: Record<string, unknown>;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const { service, level = "info", pretty = false, base = {} } = options;

  const config: LoggerOptions = {
    level,
    base: { service, ...base },

    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTED,
      // Do not throw when a path does not exist on a given object.
      remove: false,
    },

    // ISO timestamps: log aggregators handle them without configuration, and
    // they stay readable when someone is tailing a file at 3am.
    timestamp: pino.stdTimeFunctions.isoTime,

    formatters: {
      // `level: "info"` rather than `level: 30`.
      level: (label) => ({ level: label }),
    },

    /**
     * Serialise errors including the `cause` chain. Pino's default `err`
     * serialiser drops `cause`, which is where the actual reason usually lives
     * once errors are wrapped.
     */
    serializers: {
      err: (error: unknown) => serializeError(error),
      error: (error: unknown) => serializeError(error),
    },
  };

  if (pretty) {
    return pino({
      ...config,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      },
    });
  }

  return pino(config);
}

interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: string;
  statusCode?: number;
  cause?: SerializedError;
}

function serializeError(error: unknown, depth = 0): SerializedError {
  if (depth > 5) {
    return { type: "Truncated", message: "cause chain too deep" };
  }

  if (!(error instanceof Error)) {
    return { type: typeof error, message: String(error) };
  }

  const record = error as unknown as Record<string, unknown>;
  const serialized: SerializedError = {
    type: error.name,
    message: error.message,
  };

  if (error.stack !== undefined) serialized.stack = error.stack;
  if (typeof record["code"] === "string") serialized.code = record["code"];
  if (typeof record["statusCode"] === "number") serialized.statusCode = record["statusCode"];
  if (error.cause !== undefined) serialized.cause = serializeError(error.cause, depth + 1);

  return serialized;
}

export type { Logger };
