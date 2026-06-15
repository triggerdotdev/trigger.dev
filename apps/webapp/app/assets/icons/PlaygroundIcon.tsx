export function PlaygroundIcon({ className }: { className?: string }) {
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
        d="M4 20V7C4 5.34315 5.34315 4 7 4H17C18.6569 4 20 5.34315 20 7V20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
      <line
        x1="9"
        y1="17"
        x2="15"
        y2="17"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M9 15.5L9 16L10 16L10 15.5L9.5 15.5L9 15.5ZM10 2.5C10 2.22386 9.77614 2 9.5 2C9.22386 2 9 2.22386 9 2.5L9.5 2.5L10 2.5ZM9.5 15.5L10 15.5L10 2.5L9.5 2.5L9 2.5L9 15.5L9.5 15.5Z"
        fill="currentColor"
      />
      <path
        d="M14 15.5L14 16L15 16L15 15.5L14.5 15.5L14 15.5ZM15 2.5C15 2.22386 14.7761 2 14.5 2C14.2239 2 14 2.22386 14 2.5L14.5 2.5L15 2.5ZM14.5 15.5L15 15.5L15 2.5L14.5 2.5L14 2.5L14 15.5L14.5 15.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
