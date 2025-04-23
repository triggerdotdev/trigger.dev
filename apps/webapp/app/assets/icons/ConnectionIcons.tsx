export function ConnectedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="0.5"
        y="-0.5"
        width="19"
        height="1"
        rx="0.5"
        transform="matrix(1 0 0 -1 1.99998 20)"
        stroke="#878C99"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14.4187 5L6.00002 5C4.89545 5 4.00002 5.89543 4.00002 7L4.00001 15C4.00002 16.1046 4.89545 17 6.00002 17L18 17C19.1046 17 20 16.1046 20 15L20 7.9816L18.5 9.4816L18.5 15C18.5 15.2761 18.2762 15.5 18 15.5L6.00001 15.5C5.72387 15.5 5.50001 15.2761 5.50001 15L5.50002 7C5.50002 6.72386 5.72387 6.5 6.00002 6.5L12.9187 6.5L14.4187 5Z"
        fill="#878C99"
      />
      <path
        d="M8.50002 9.75L11.5 12.75L18 6"
        stroke="#28BF5C"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DisconnectedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14.673 19L2.99998 19C2.44769 19 1.99998 19.4477 1.99998 20C1.99998 20.5523 2.44769 21 2.99998 21L16.673 21L14.673 19Z"
        fill="#878C99"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3.99999 8.32703L3.99999 15C3.99999 16.1046 4.89542 17 5.99999 17L12.673 17L11.173 15.5L5.99999 15.5C5.72385 15.5 5.49999 15.2761 5.49999 15L5.49999 9.82703L3.99999 8.32703ZM18.5 14.2641L18.5 7C18.5 6.72386 18.2761 6.5 18 6.5L10.7358 6.5L9.23585 5L18 5C19.1046 5 20 5.89543 20 7L20 15C20 15.2292 19.9614 15.4495 19.8904 15.6546L18.5 14.2641Z"
        fill="#878C99"
      />
      <path d="M3.00001 3L21 21" stroke="#E11D48" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function CheckingConnectionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="0.5"
        y="-0.5"
        width="19"
        height="1"
        rx="0.5"
        transform="matrix(1 0 0 -1 1.99998 20)"
        stroke="#878C99"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M18 6.5L6.00001 6.5C5.72387 6.5 5.50001 6.72386 5.50001 7L5.50001 15C5.50001 15.2761 5.72387 15.5 6.00001 15.5L18 15.5C18.2762 15.5 18.5 15.2761 18.5 15V7C18.5 6.72386 18.2762 6.5 18 6.5ZM6.00001 5C4.89545 5 4.00001 5.89543 4.00001 7L4.00001 15C4.00001 16.1046 4.89545 17 6.00001 17L18 17C19.1046 17 20 16.1046 20 15V7C20 5.89543 19.1046 5 18 5L6.00001 5Z"
        fill="#878C99"
      />
      <circle cx="9" cy="11" r="1" fill="#878C99" />
      <circle cx="12" cy="11" r="1" fill="#878C99" />
      <circle cx="15" cy="11" r="1" fill="#878C99" />
    </svg>
  );
}
