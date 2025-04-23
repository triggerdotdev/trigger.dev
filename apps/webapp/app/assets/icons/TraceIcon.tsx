export function TraceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="13" height="6" rx="2" fill="currentColor" />
      <rect x="9" y="9" width="13" height="6" rx="2" fill="currentColor" />
      <rect x="2" y="16" width="13" height="6" rx="2" fill="currentColor" />
    </svg>
  );
}
