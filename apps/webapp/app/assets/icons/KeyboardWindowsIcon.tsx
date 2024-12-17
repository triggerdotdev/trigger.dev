export function KeyboardWindowsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="5.5" y="5.5" width="6" height="6" fill="currentColor" />
      <rect x="12.5" y="5.5" width="6" height="6" fill="currentColor" />
      <rect x="5.5" y="12.5" width="6" height="6" fill="currentColor" />
      <rect x="12.5" y="12.5" width="6" height="6" fill="currentColor" />
    </svg>
  );
}
