export function RadarPulseIcon({ className }: { className?: string }) {
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
        d="M5.7 5.57275C4.03377 7.20618 3 9.48239 3 12C3 14.5177 4.03377 16.7939 5.7 18.4273M18.4273 5.70004C20.0187 7.32342 21 9.54714 21 12C21 14.453 20.0187 16.6767 18.4273 18.3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M8.5 8.42932C7.57432 9.33678 7 10.6013 7 12C7 13.3628 7.54516 14.5982 8.42928 15.5M15.5707 8.50004C16.4548 9.40191 17 10.6373 17 12C17 13.3987 16.4257 14.6633 15.5 15.5708"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}
