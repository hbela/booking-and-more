const shortHeading =
  /^(?:#{1,6}\s+)?(?:\*\*)?(?:short description|rövid le[ií]rás):?(?:\*\*)?\s*:?[ \t]*/i;
const longHeading =
  /(?:^|\n|\s(?=\*\*))(?:#{1,6}\s+)?(?:\*\*)?(?:long description|detailed description|részletes le[ií]rás|le[ií]rás):?(?:\*\*)?\s*:?[ \t]*/i;

/** One stored field, shared by original descriptions and their translations. */
export function splitServiceDescription(description: string | null | undefined): {
  short: string;
  long: string;
} {
  const text = (description ?? "").trim();
  const separator = /\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/.exec(text);
  if (separator) {
    return {
      short: text.slice(0, separator.index).replace(shortHeading, "").trim(),
      long: text
        .slice(separator.index + separator[0].length)
        .replace(longHeading, "")
        .trim(),
    };
  }

  const body = text.replace(shortHeading, "").trim();
  const heading = longHeading.exec(body);
  if (heading) {
    return {
      short: body.slice(0, heading.index).trim(),
      long: body.slice(heading.index + heading[0].length).trim(),
    };
  }

  // Existing descriptions use a short heading followed by named bold sections.
  const section = shortHeading.test(text) ? /\s+(?=\*\*[^*]+\*\*)/.exec(body) : null;
  if (section) {
    return { short: body.slice(0, section.index).trim(), long: body.slice(section.index).trim() };
  }

  // Older unstructured descriptions stay readable without filling the page.
  if (body.length > 240) {
    const preview = body.slice(0, 240);
    const boundary = preview.lastIndexOf(" ");
    return { short: `${preview.slice(0, boundary > 120 ? boundary : 240).trimEnd()}…`, long: body };
  }
  return { short: body, long: "" };
}
