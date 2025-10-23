export function ConcurrencyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="3.75" cy="3.75" r="2.25" fill="currentColor" />
      <circle cx="9" cy="3.75" r="2.25" fill="currentColor" />
      <circle cx="14.25" cy="3.75" r="2.25" fill="currentColor" />
      <circle cx="3.75" cy="9" r="2.25" fill="currentColor" />
      <circle cx="9" cy="9" r="2.25" fill="currentColor" />
      <circle cx="9" cy="14.25" r="1.75" stroke="currentColor" />
      <circle cx="14.25" cy="9" r="2.25" fill="currentColor" />
    </svg>
  );
}
