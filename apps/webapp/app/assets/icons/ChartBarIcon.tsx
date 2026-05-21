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
        d="M9 6C9 4.89543 9.89543 4 11 4H13C14.1046 4 15 4.89543 15 6V21H9V6Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M15 12C15 10.8954 15.8954 10 17 10H19C20.1046 10 21 10.8954 21 12V20C21 20.5523 20.5523 21 20 21H15V12Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M3 16C3 14.8954 3.89543 14 5 14H7C8.10457 14 9 14.8954 9 16V21H4C3.44772 21 3 20.5523 3 20V16Z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
