export function TaskIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 5C2 3.34315 3.34315 2 5 2H19C20.6569 2 22 3.34315 22 5V19C22 20.6569 20.6569 22 19 22H5C3.34315 22 2 20.6569 2 19V5ZM7.5035 8C7.5035 8.55228 7.95122 9 8.5035 9H11V16.4954C11 17.0476 11.4477 17.4954 12 17.4954C12.5523 17.4954 13 17.0476 13 16.4954V9H15.4965C16.0488 9 16.4965 8.55228 16.4965 8C16.4965 7.44772 16.0488 7 15.4965 7H8.5035C7.95122 7 7.5035 7.44772 7.5035 8Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function TaskIconSmall({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 4C2 2.89543 2.89543 2 4 2H16C17.1046 2 18 2.89543 18 4V16C18 17.1046 17.1046 18 16 18H4C2.89543 18 2 17.1046 2 16V4ZM6 7C6 7.55228 6.44772 8 7 8H9L9 14C9 14.5523 9.44772 15 10 15C10.5523 15 11 14.5523 11 14V8H13C13.5523 8 14 7.55228 14 7C14 6.44772 13.5523 6 13 6H10H7C6.44772 6 6 6.44772 6 7Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SandboxesIconSmall({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10 2C14.4183 2 18 5.58172 18 10C18 14.4183 14.4183 18 10 18C5.58172 18 2 14.4183 2 10C2 5.58172 5.58172 2 10 2ZM10 4C6.68629 4 4 6.68629 4 10C4 13.3137 6.68629 16 10 16C13.3137 16 16 13.3137 16 10C16 6.68629 13.3137 4 10 4Z"
        fill="currentColor"
      />
    </svg>
  );
}
