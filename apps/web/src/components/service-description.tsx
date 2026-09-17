import { splitServiceDescription } from "../lib/service-description";

function DescriptionText({ text }: { text: string }): React.ReactElement {
  return (
    <span className="whitespace-pre-wrap break-words">
      {text
        .split(/(\*\*[^*]+\*\*)/g)
        .map((part, index) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={index}>{part.slice(2, -2)}</strong>
          ) : (
            part
          ),
        )}
    </span>
  );
}

export function ServiceDescription({
  description,
  longDescriptionLabel,
}: {
  description: string | null;
  longDescriptionLabel: string;
}): React.ReactElement | null {
  const content = splitServiceDescription(description);
  if (!content.short && !content.long) return null;

  return (
    <div className="px-4 pb-4 text-sm">
      {content.short ? (
        <p>
          <DescriptionText text={content.short} />
        </p>
      ) : null}
      {content.long ? (
        <details className="mt-2">
          <summary className="text-primary min-h-11 cursor-pointer rounded-lg py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
            {longDescriptionLabel}
          </summary>
          <div className="pt-2">
            <DescriptionText text={content.long} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
