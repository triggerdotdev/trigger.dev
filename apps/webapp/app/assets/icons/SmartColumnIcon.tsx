/** Marks a smart column: in the runs table header, the Columns popover, and the dialog preview. */
export function SmartColumnIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M5.94723 12.4318L12.3011 3.53646C12.9468 2.63242 14.3689 3.24855 14.1511 4.33794L13.1543 9.32131C13.0905 9.64031 13.3346 9.93793 13.6599 9.93793H17.2138C18.0524 9.93793 18.5402 10.8859 18.0527 11.5682L11.6989 20.4636C11.0532 21.3676 9.63107 20.7515 9.84895 19.6621L10.8456 14.6788C10.9095 14.3598 10.6654 14.0621 10.3401 14.0621H6.78622C5.9476 14.0621 5.45978 13.1142 5.94723 12.4318Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
