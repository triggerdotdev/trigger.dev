export function PauseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M0 10C0 4.47715 4.47715 0 10 0C15.5228 0 20 4.47715 20 10C20 15.5228 15.5228 20 10 20C4.47715 20 0 15.5228 0 10ZM6.5 6C6.5 5.44772 6.94772 5 7.5 5C8.05229 5 8.5 5.44772 8.5 6V14C8.5 14.5523 8.05229 15 7.5 15C6.94772 15 6.5 14.5523 6.5 14V6ZM12.5 5C11.9477 5 11.5 5.44772 11.5 6V14C11.5 14.5523 11.9477 15 12.5 15C13.0523 15 13.5 14.5523 13.5 14V6C13.5 5.44772 13.0523 5 12.5 5Z"
        fill="currentColor"
      />
    </svg>
  );
}
