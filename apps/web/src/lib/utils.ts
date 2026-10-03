/**
 * shadcn/ui's conventional import path for `cn` (phase-11-shadcn-adoption §2.1).
 *
 * The registry's components import `@/lib/utils`, and the CLI's alias rewrite
 * mangles a non-standard target, so this path exists for them. The function
 * and its rationale live in `./cn.ts`; this file must stay a re-export.
 */
export { cn } from "./cn";
