export function HomeIcon({ className }: { className?: string }) {
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
        d="M4 8.23607C4 7.47852 4.428 6.786 5.10557 6.44721L11.1056 3.44721C11.6686 3.16569 12.3314 3.16569 12.8944 3.44721L18.8944 6.44721C19.572 6.786 20 7.47852 20 8.23607V19C20 20.1046 19.1046 21 18 21H6C4.89543 21 4 20.1046 4 19V8.23607Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M15 21V15C15 13.8954 14.1046 13 13 13H11C9.89543 13 9 13.8954 9 15V21"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
