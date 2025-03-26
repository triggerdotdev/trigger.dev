export function WebhookTaskIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="2.5"
        stroke="currentColor"
        strokeOpacity="0.5"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15.4939 7.33333C14.2085 7.33333 13.1665 8.37533 13.1665 9.66071V10.4444H14.7221H15.8887V12.7778H14.7221H13.1665V14.3401C13.1665 16.9136 11.0802 19 8.50669 19H7.34003V16.6666H8.50669C9.79157 16.6666 10.8332 15.625 10.8332 14.3401V12.7778H9.27764H8.11097V10.4444H9.27764H10.8332V9.66071C10.8332 7.08668 12.9199 5 15.4939 5H16.6606V7.33333H15.4939Z"
        fill="currentColor"
      />
    </svg>
  );
}
