export function ShieldIcon({ className }: { className?: string }) {
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
        d="M6 3H18C19.1046 3 20 3.89543 20 5V12.0029C20 14.0232 19.1268 15.9452 17.6055 17.2744L14.6318 19.8721C13.1244 21.1891 10.8756 21.1891 9.36816 19.8721L6.39453 17.2744C4.8732 15.9452 4.00005 14.0232 4 12.0029V5L4.01074 4.7959C4.11301 3.78722 4.96435 3 6 3Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M9.03125 11L11.0312 13.0625L15.0312 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
