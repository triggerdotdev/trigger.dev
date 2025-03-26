export function RunFunctionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="2.5"
        stroke="currentColor"
        strokeOpacity={0.5}
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 8H10V12V16.5159H12V12C12 10.8954 12.8954 10 14 10H15.5V8H14C13.2714 8 12.5883 8.19479 12 8.53513V8Z"
        fill="currentColor"
      />
    </svg>
  );
}
