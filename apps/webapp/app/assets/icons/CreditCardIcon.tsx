export function CreditCardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="9" width="16" height="2" fill="currentColor" />
      <rect x="6" y="13" width="7" height="2" rx="1" fill="currentColor" />
    </svg>
  );
}
