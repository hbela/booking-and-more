/* eslint-disable no-console -- CLI script; console is the output channel */
import { AnthropicIntentInterpreter, tokenCostMinor } from "@bam/ai";
import { loadEnv } from "@bam/config";
import { createPrismaClient } from "@bam/db";
import { groundingIssues } from "@bam/knowledge-engine";
import { AssistantService } from "../src/modules/assistant/assistant.service.js";
import { groundingFacts } from "../src/modules/assistant/knowledge-health.js";
import { ConversationTools } from "../src/modules/public/conversation.tools.js";

/**
 * Is the receptionist consistent? (docs/phase-12-assistant-knowledge-consistency.md §6)
 *
 *   pnpm assistant:eval <tenant-slug> [--runs 5] [--locale hu|en|both] [--yes]
 *
 * Asks the real model a fixed set of customer questions, each several times,
 * through the same input the chat builds — the catalogue, `<bookable-facts>`,
 * `<business-description>` — and judges every answer mechanically:
 *
 * - **grounded**: a question the app answers from records (`LIST_SERVICES`,
 *   `GET_SERVICE_DETAILS`, `GET_LOCATION_DETAILS`) is grounded by construction;
 *   a model-written `ANSWER_FAQ` is grounded when `groundingIssues` finds no
 *   person, city, hours or price outside the records — the same check that
 *   flags live transcripts (§4.5);
 * - **routed**: the intent is one of those the question should get;
 * - **consistent**: every run of a question chose the same intent and the same
 *   verdict.
 *
 * ## What it costs, and who pays
 *
 * Real calls, so real money: it prints the plan and spends nothing without
 * `--yes`. It does **not** meter against the tenant's allowance — an operator
 * measuring the product is not the tenant using it — and it prints the token
 * total and estimated cost instead. It never runs in CI: the model is not
 * deterministic and the bill is not zero.
 *
 * ## What it touches
 *
 * Reads only. No conversation, message, usage or audit row is written. It is a
 * script rather than a route for rule 7's reason.
 */

interface Question {
  id: string;
  text: Record<"hu" | "en", string>;
  /** Intents a correct routing may choose. */
  expect: string[];
}

const QUESTIONS: Question[] = [
  {
    id: "services",
    text: { hu: "Milyen szolgáltatásokat kínálnak?", en: "What treatments do you offer?" },
    expect: ["LIST_SERVICES"],
  },
  {
    id: "unbookable",
    text: {
      hu: "Tudok fogszabályozásra időpontot foglalni?",
      en: "Can I book an appointment for braces?",
    },
    expect: ["GET_SERVICE_DETAILS", "LIST_SERVICES"],
  },
  {
    id: "people",
    text: { hu: "Ki a fogorvos?", en: "Who are your doctors?" },
    expect: ["ANSWER_FAQ"],
  },
  {
    id: "place",
    text: { hu: "Hol vannak?", en: "Where are you?" },
    expect: ["GET_LOCATION_DETAILS"],
  },
  {
    id: "hours",
    text: { hu: "Mikor vannak nyitva?", en: "When are you open?" },
    expect: ["ANSWER_FAQ"],
  },
  {
    id: "price",
    text: { hu: "Mennyibe kerül a konzultáció?", en: "How much is a consultation?" },
    expect: ["ANSWER_FAQ", "GET_SERVICE_DETAILS"],
  },
];

const RECORD_RENDERED = new Set(["LIST_SERVICES", "GET_SERVICE_DETAILS", "GET_LOCATION_DETAILS"]);

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const slug = args[0];
  const runs = Number(flagValue(args, "--runs") ?? 5);
  const localeFlag = flagValue(args, "--locale") ?? "both";
  const locales = (localeFlag === "both" ? ["hu", "en"] : [localeFlag]) as ("hu" | "en")[];

  if (
    !slug ||
    slug.startsWith("--") ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 20 ||
    locales.some((locale) => locale !== "hu" && locale !== "en")
  ) {
    console.error(
      "Usage: pnpm assistant:eval <tenant-slug> [--runs 1-20] [--locale hu|en|both] [--yes]\n" +
        "Asks the real model a fixed question set and reports routing, grounding and consistency.",
    );
    process.exit(1);
  }

  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set: there is no model to evaluate.");
    process.exit(1);
  }
  const calls = QUESTIONS.length * locales.length * runs;
  console.log(
    `Plan: ${String(QUESTIONS.length)} questions × ${locales.join("+")} × ${String(runs)} runs = ${String(calls)} calls to ${env.ANTHROPIC_CHAT_MODEL}.`,
  );
  if (!args.includes("--yes")) {
    console.log("Nothing spent. Re-run with --yes to make the calls.");
    return;
  }

  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      console.error(`No tenant with slug "${slug}".`);
      process.exit(1);
    }
    const interpreter = new AnthropicIntentInterpreter({
      apiKey: env.ANTHROPIC_API_KEY,
      chatModel: env.ANTHROPIC_CHAT_MODEL,
      maxOutputTokens: env.CHAT_MAX_OUTPUT_TOKENS,
    });
    const assistant = new AssistantService(prisma);
    const tools = new ConversationTools(prisma);
    const facts = await groundingFacts(prisma, tenant.id);
    let inputTokens = 0;
    let outputTokens = 0;
    let failedQuestions = 0;

    for (const locale of locales) {
      const knowledge = await assistant.knowledgeContext(tenant, locale);
      const catalogue = await tools.catalogueFor(tenant.id, locale);
      console.log(`\n=== ${tenant.name} · ${locale} ===`);

      for (const question of QUESTIONS) {
        const results: { intent: string; grounded: boolean; detail: string }[] = [];
        for (let run = 0; run < runs; run++) {
          try {
            const { envelope, usage } = await interpreter.interpret({
              utterance: question.text[locale],
              locale,
              timezone: tenant.defaultTimezone,
              state: "START",
              history: [],
              catalogue,
              bookableFacts: knowledge.bookableFacts,
              businessContext: knowledge.businessDescription,
            });
            inputTokens += usage.inputTokens ?? 0;
            outputTokens += usage.outputTokens ?? 0;
            const answer =
              typeof envelope.parameters["answer"] === "string"
                ? envelope.parameters["answer"]
                : "";
            const issues = envelope.intent === "ANSWER_FAQ" ? groundingIssues(answer, facts) : [];
            results.push({
              intent: envelope.intent,
              grounded:
                RECORD_RENDERED.has(envelope.intent) ||
                (envelope.intent === "ANSWER_FAQ" && answer !== "" && issues.length === 0),
              detail:
                envelope.intent === "ANSWER_FAQ"
                  ? `${answer.replace(/\s+/gu, " ").slice(0, 140)}${
                      issues.length > 0
                        ? `  ⚠ ${issues.map((issue) => `${issue.kind}:${issue.value}`).join(", ")}`
                        : ""
                    }`
                  : "(answered from records)",
            });
          } catch (error) {
            results.push({
              intent: "ERROR",
              grounded: false,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const passed = results.filter(
          (result) => result.grounded && question.expect.includes(result.intent),
        ).length;
        const intents = [...new Set(results.map((result) => result.intent))];
        const consistent =
          intents.length === 1 && new Set(results.map((result) => result.grounded)).size === 1;
        if (passed < runs || !consistent) failedQuestions += 1;

        console.log(
          `\n${passed === runs && consistent ? "PASS" : "FAIL"} ${question.id}: ${String(passed)}/${String(runs)} correct · ${consistent ? "consistent" : "INCONSISTENT"} · intents: ${intents.join(", ")}`,
        );
        console.log(`  Q: ${question.text[locale]}`);
        results.forEach((result, index) =>
          console.log(`  ${String(index + 1)}. [${result.intent}] ${result.detail}`),
        );
      }
    }

    console.log(
      `\nTokens: ${String(inputTokens)} in / ${String(outputTokens)} out · estimated ${(
        tokenCostMinor({ model: env.ANTHROPIC_CHAT_MODEL, inputTokens, outputTokens }) / 100
      ).toFixed(2)} USD (not metered against the tenant).`,
    );
    console.log(
      failedQuestions === 0
        ? "Every question was routed, grounded and consistent on every run."
        : `${String(failedQuestions)} question(s) failed. The FAIL lines say which, and how.`,
    );
    process.exitCode = failedQuestions === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
