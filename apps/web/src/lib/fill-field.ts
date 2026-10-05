/**
 * Put text into an uncontrolled field the way typing would, so React's
 * onChange — and the character budget hanging off it — sees the change.
 *
 * The event is untrusted (`isTrusted` is false), which is how an editor tells
 * a machine draft from the owner's own typing (phase-12 §8.4).
 */
export function fill(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A new set without `value`, or the same one when it was not there. */
export function without<T>(current: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (!current.has(value)) return current;
  const next = new Set(current);
  next.delete(value);
  return next;
}
