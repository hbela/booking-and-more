import { fold } from "./text.js";
import type { KnowledgeFinding } from "./types.js";

/**
 * A finding's identity across reads (phase-12 §3.3), so an owner can mark it
 * as intended and have it stay marked.
 *
 * The excerpt is part of it, folded: changing the case or the punctuation of a
 * sentence keeps the acknowledgement, rewording it does not — what the owner
 * approved was that sentence. The source is part of it too, so the same name
 * acknowledged in the profile is still reported in an FAQ.
 */
export function findingKey(finding: KnowledgeFinding): string {
  return [
    finding.code,
    finding.source.kind,
    finding.source.id ?? "",
    finding.source.locale ?? "",
    fold(finding.excerpt),
  ].join("|");
}
