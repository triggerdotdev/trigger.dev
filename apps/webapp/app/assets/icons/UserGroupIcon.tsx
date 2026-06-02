export function UserGroupIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="7.5" r="2.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="19" cy="9.5" r="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="5" cy="9.5" r="2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 13C9.28772 13 8.29961 15.0954 8.06142 17.0026C7.99297 17.5507 8.44772 18 9 18H15C15.5523 18 16.007 17.5507 15.9386 17.0026C15.7004 15.0954 14.7123 13 12 13Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M19 18H20C20.5523 18 21.0112 17.5481 20.904 17.0063C20.6537 15.7422 19.867 14.4289 18 14.0859"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M5 17.9141H4C3.44772 17.9141 2.9888 17.4621 3.09604 16.9203C3.34626 15.6562 4.13299 14.3429 6 14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
