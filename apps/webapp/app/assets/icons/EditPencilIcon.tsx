/** Pencil over a couple of text lines — editing a value in place. */
export function EditPencilIcon({ className }: { className?: string }) {
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
        d="M18.7573 3.6275L20.3732 5.24335C21.1542 6.0244 21.1542 7.29073 20.3732 8.07178L9.72032 18.7246C9.57777 18.8671 9.3957 18.9631 9.19759 19.0002L4.03377 19.9669L5.00052 14.8031C5.03765 14.6051 5.1336 14.4229 5.27604 14.2804L15.9289 3.6275C16.71 2.84645 17.9763 2.84645 18.7573 3.6275Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <line x1="17.6464" y1="10.3536" x2="13.6464" y2="6.35355" stroke="currentColor" />
      <path d="M13 21L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M18 17L21 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
