export function QuestionMarkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12.0232" r="9" stroke="currentColor" strokeWidth="2" />
      <path
        d="M9.27051 8.7533C9.7438 7.71876 10.788 7 12 7C13.6569 7 15 8.34315 15 10C15 11.6569 13.6569 13 12 13V14.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </svg>
  );
}
