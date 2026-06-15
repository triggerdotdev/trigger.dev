export function ChartBarIcon({ className }: { className?: string }) {
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
        d="M9 5C9 3.89543 9.89543 3 11 3H13C14.1046 3 15 3.89543 15 5V21H9V5Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M15 13C15 11.8954 15.8954 11 17 11H19C20.1046 11 21 11.8954 21 13V20C21 20.5523 20.5523 21 20 21H15V13Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M3 10C3 8.89543 3.89543 8 5 8H7C8.10457 8 9 8.89543 9 10V21H4C3.44772 21 3 20.5523 3 20V10Z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
