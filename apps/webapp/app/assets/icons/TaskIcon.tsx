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
