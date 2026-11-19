/** The Daybook mark: a bound ledger with the double red margin rule and a tick written on the ruled lines. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 30) / 26} viewBox="0 0 26 30" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="25" height="29" rx="1.5" fill="none" stroke="currentColor" />
      <path d="M6 1v28M8.5 1v28" stroke="var(--red)" />
      <path d="M8.5 9.5h17M8.5 15.5h17M8.5 21.5h17" stroke="currentColor" strokeOpacity=".35" />
      <path d="M13 18.5l3 3 6-8" fill="none" stroke="var(--red)" strokeWidth="1.6" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark />
      <span style={{ font: "italic 400 24px/1 var(--serif)", letterSpacing: "-0.01em" }}>Daybook</span>
    </span>
  );
}
