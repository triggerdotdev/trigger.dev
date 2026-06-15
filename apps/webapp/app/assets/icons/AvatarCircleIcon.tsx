export function AvatarCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="9.5" r="2.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M6 19C7.00156 16.6478 9.32233 15 12.0254 15C14.6837 15 16.9724 16.5938 18 18.884"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
