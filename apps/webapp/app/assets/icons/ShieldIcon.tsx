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
        d="M11.4199 3.2207C11.7981 3.1061 12.2019 3.1061 12.5801 3.2207L18.5801 5.03906C19.4233 5.29464 20 6.072 20 6.95312V11.4951C20 13.7676 18.8965 15.899 17.041 17.2109L12 20.7754L6.95898 17.2109C5.10346 15.899 4 13.7676 4 11.4951V6.95312C4 6.072 4.57669 5.29464 5.41992 5.03906L11.4199 3.2207Z"
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
