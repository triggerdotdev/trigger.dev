export function PrivateIcon({ className }: { className?: string }) {
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
        d="M7.68555 4H16.3145C17.3336 4 18.1902 4.76643 18.3027 5.7793L18.8828 11H5.11719L5.69727 5.7793C5.80981 4.76643 6.66645 4 7.68555 4Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect x="5" y="14" width="5" height="5" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="14" width="5" height="5" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="2" y="10" width="20" height="2" rx="1" fill="currentColor" />
      <path
        d="M15 15L13.5811 14.527C12.5548 14.1849 11.4452 14.1849 10.4189 14.527L9 15"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
