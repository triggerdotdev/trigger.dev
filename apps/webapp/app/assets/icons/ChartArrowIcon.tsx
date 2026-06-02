export function ChartArrowIcon({ className }: { className?: string }) {
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
        d="M9 12C9 10.8954 9.89543 10 11 10H13C14.1046 10 15 10.8954 15 12V21H9V12Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M15 7C15 5.89543 15.8954 5 17 5H19C20.1046 5 21 5.89543 21 7V20C21 20.5523 20.5523 21 20 21H15V7Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M3 17C3 15.8954 3.89543 15 5 15H7C8.10457 15 9 15.8954 9 17V21H4C3.44772 21 3 20.5523 3 20V17Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M3 5.5L8 5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.4 8L9.9 5.50005L7.39995 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
