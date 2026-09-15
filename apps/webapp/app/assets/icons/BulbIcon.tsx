export function BulbIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M15 19V17V16.9584C15 16.5724 15.2256 16.2261 15.5579 16.0296C17.6182 14.8113 19 12.567 19 10C19 6.13401 15.866 3 12 3C8.13401 3 5 6.13401 5 10C5 12.567 6.38176 14.8113 8.44208 16.0296C8.77437 16.2261 9 16.5724 9 16.9584V17V19C9 20.1046 9.89543 21 11 21H13C14.1046 21 15 20.1046 15 19Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <line x1="9" y1="17" x2="15" y2="17" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
