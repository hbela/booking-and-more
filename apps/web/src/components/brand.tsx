/** Product signature: a calendar with a plus for the services beyond booking. */
export function Brand(): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-3 text-ink">
      <svg
        viewBox="0 0 40 40"
        width="40"
        height="40"
        fill="none"
        aria-hidden="true"
        className="shrink-0 text-primary"
      >
        <rect x="1" y="1" width="38" height="38" rx="10" fill="currentColor" />
        <g
          className="text-on-primary"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="10" y="12" width="20" height="19" rx="3" />
          <path d="M15 9v6m10-6v6M10 19h20m-10 3v6m-3-3h6" />
        </g>
      </svg>
      <span className="font-display text-base font-bold tracking-tight">
        Booking <span className="font-normal text-ink-muted">and</span> More
      </span>
    </span>
  );
}
