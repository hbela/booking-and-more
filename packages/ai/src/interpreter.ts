import { commandEnvelopeSchema, conversationIntentSchema } from "@bam/contracts";
import type Anthropic from "@anthropic-ai/sdk";

import { getAnthropic, type AnthropicConfig } from "./client.js";
import { buildSystemPrompt, buildUserMessages } from "./prompt.js";
import { tokenUsage } from "./pricing.js";
import type { IntentInterpreter, InterpretationInput, InterpretationResult } from "./types.js";

/**
 * Intent extraction against OpenAI's structured outputs. tech-impl §20, §21.
 *
 * The model is constrained twice over. The response schema below is enforced by
 * the provider, so what comes back is shaped like an envelope; then
 * `commandEnvelopeSchema` parses it here, because "the provider promised" is not
 * a validation and a provider outage that returns a plausible 200 should fail
 * loudly rather than plausibly.
 *
 * The caller then validates the parameters against the intent's own schema
 * (`parseCommand`). Nothing in this file executes anything.
 */

const PROVIDER = "anthropic";

/**
 * Every parameter any intent can take, flattened.
 *
 * Structured outputs in strict mode cannot express "an open record": every
 * property must be listed and every property must be required. So the schema is
 * the union of all intents' parameters, all nullable, and `stripNulls` removes
 * the ones the model left empty. `parseCommand` then drops whatever the chosen
 * intent does not accept — which is what makes a flat union safe rather than a
 * way to smuggle a `serviceId` into a cancellation.
 */
const PARAMETER_PROPERTIES: Record<string, { type: string[]; description?: string }> = {
  query: { type: ["string", "null"] },
  serviceId: { type: ["string", "null"], description: "Only an id from the catalogue block." },
  serviceQuery: { type: ["string", "null"], description: "The customer's own words." },
  providerId: { type: ["string", "null"] },
  providerQuery: { type: ["string", "null"] },
  locationId: { type: ["string", "null"] },
  dateExpression: {
    type: ["string", "null"],
    description: "The words the customer used, never a date. 'tomorrow', 'jövő kedden'.",
  },
  timeExpression: {
    type: ["string", "null"],
    description: "The words the customer used. 'délután', 'around 5'.",
  },
  slotOrdinal: {
    type: ["integer", "null"],
    description: "Which slot from the list they were shown, counting from 1.",
  },
  startAt: {
    type: ["string", "null"],
    description: "Only when the customer picked a slot from the on-screen list.",
  },
  fullName: { type: ["string", "null"] },
  email: { type: ["string", "null"] },
  phone: { type: ["string", "null"] },
  notes: { type: ["string", "null"] },
  reference: { type: ["string", "null"] },
  reason: { type: ["string", "null"] },
  answer: { type: ["string", "null"], description: "Only an answer grounded in the business facts block." },
};

const RESPONSE_SCHEMA: Anthropic.Tool["input_schema"] = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "confidence", "parameters", "missingFields", "requiresConfirmation"],
  properties: {
    intent: { type: "string", enum: conversationIntentSchema.options },
    confidence: { type: "number" },
    parameters: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(PARAMETER_PROPERTIES),
      properties: PARAMETER_PROPERTIES,
    },
    missingFields: { type: "array", items: { type: "string" } },
    requiresConfirmation: { type: "boolean" },
  },
};

function stripNulls(parameters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(parameters).filter(([, value]) => value !== null && value !== ""),
  );
}

export class AnthropicIntentInterpreter implements IntentInterpreter {
  constructor(private readonly config: AnthropicConfig) {}

  async interpret(input: InterpretationInput): Promise<InterpretationResult> {
    const client = getAnthropic(this.config);
    const model = this.config.chatModel;

    const stream = client.messages.stream({
      model,
      max_tokens: this.config.maxOutputTokens,
      system: buildSystemPrompt(input),
      messages: buildUserMessages(input),
      tools: [{ name: "emit_command", description: "Return the validated customer intent.", input_schema: RESPONSE_SCHEMA }],
      tool_choice: { type: "tool", name: "emit_command" },
    });
    const completion = await stream.finalMessage();

    const usage = tokenUsage({
      provider: PROVIDER,
      model,
      inputTokens: completion.usage.input_tokens,
      outputTokens: completion.usage.output_tokens,
    });

    const content = completion.content.find((block) => block.type === "tool_use");

    // A refusal or an empty choice is a failed interpretation, not an empty
    // envelope. Returning `OUT_OF_SCOPE` here would tell the customer they asked
    // for something we do not do, when what happened is that we could not hear
    // them (phase-9-owner-onboarding-emails.md §2's rule, applied).
    if (content === undefined || content.type !== "tool_use") {
      throw new Error("The interpreter returned no content.");
    }

    const envelope = commandEnvelopeSchema.parse(content.input);

    return {
      envelope: { ...envelope, parameters: stripNulls(envelope.parameters) },
      usage,
    };
  }
}
