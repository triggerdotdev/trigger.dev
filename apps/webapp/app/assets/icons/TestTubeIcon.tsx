export function TestTubeIcon({ className }: { className?: string }) {
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
        d="M4.12132 19.8492C2.94975 18.6777 2.94975 16.7782 4.12132 15.6066L13.6007 6.12724C13.9912 5.73672 14.6244 5.73672 15.0149 6.12724L17.8433 8.95567C18.2338 9.34619 18.2338 9.97936 17.8433 10.3699L8.36396 19.8492C7.19239 21.0208 5.29289 21.0208 4.12132 19.8492Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="19" cy="6" r="1" fill="currentColor" />
      <circle cx="19" cy="3" r="1" fill="currentColor" />
      <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="2" />
      <path d="M13 4L20 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
