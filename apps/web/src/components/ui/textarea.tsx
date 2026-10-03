import { cn } from "@/lib/utils";

import { controlClasses } from "./input";

/** shadcn/ui's Textarea, with the same §2.4 adaptations as {@link ./input.tsx}. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        controlClasses,
        "flex field-sizing-content min-h-24 resize-y px-3 py-2 text-base md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
