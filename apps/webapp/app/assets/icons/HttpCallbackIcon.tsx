export function HttpCallbackIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M21 12a9 9 0 1 0 -9 9" />
      <path d="M3.6 9h16.8" />
      <path d="M3.6 15h8.4" />
      <path d="M11.578 3a17 17 0 0 0 0 18" />
      <path d="M12.5 3c1.719 2.755 2.5 5.876 2.5 9" />
      <path d="M18 21v-7m3 3l-3 -3l-3 3" />
    </svg>
  );
}
