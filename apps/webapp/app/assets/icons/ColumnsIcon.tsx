export function ColumnsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <line x1="9" y1="19" x2="9" y2="5" stroke="currentColor" strokeWidth="2" />
      <line x1="15" y1="19" x2="15" y2="5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
