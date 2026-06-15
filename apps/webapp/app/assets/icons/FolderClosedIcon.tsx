export function FolderClosedIcon({ className }: { className?: string }) {
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
        d="M3 6C3 4.89543 3.89543 4 5 4H8.26265C8.73856 4 9.19887 4.16971 9.56089 4.47863L10.9391 5.65471C11.3011 5.96363 11.7614 6.13333 12.2373 6.13333H19C20.1046 6.13333 21 7.02876 21 8.13333V18C21 19.1046 20.1046 20 19 20H5C3.89543 20 3 19.1046 3 18V6Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect x="3" y="10" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
