import type { ResponseComposer, ResponseInput, ResponseResult } from "./types.js";

/**
 * The response composer that reaches no model. tech-impl §20's
 * `TemplateResponseComposer`.
 *
 * It passes the engine's message key straight through, and that is the whole
 * implementation. It exists as a class rather than as nothing so that the seam
 * the spec asks for is present the day somebody wants a chattier assistant — and
 * so that "the assistant's wording never came from a model" is a fact about one
 * named object rather than an absence somebody has to notice.
 *
 * `@bam/conversation-engine`'s `templates.ts` carries the argument for why every
 * common step is a template: a reply that is a key cannot drift between deploys,
 * cannot be steered by a tenant's service name, and costs nothing.
 */
export class TemplateResponseComposer implements ResponseComposer {
  compose(input: ResponseInput): Promise<ResponseResult> {
    return Promise.resolve({
      key: input.messageKey,
      ...(input.params === undefined ? {} : { params: input.params }),
    });
  }
}
