export function ConnectedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="0.5"
        y="-0.5"
        width="19"
        height="1"
        rx="0.5"
        transform="matrix(1 0 0 -1 0 17)"
        stroke="#878C99"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.4187 2L4 2C2.89543 2 2 2.89543 2 4L2 12C2 13.1046 2.89543 14 4 14L16 14C17.1046 14 18 13.1046 18 12L18 4.9816L16.5 6.4816L16.5 12C16.5 12.2761 16.2761 12.5 16 12.5L4 12.5C3.72386 12.5 3.5 12.2761 3.5 12L3.5 4C3.5 3.72386 3.72386 3.5 4 3.5L10.9187 3.5L12.4187 2Z"
        fill="#878C99"
      />
      <path
        d="M6.5 6.75L9.5 9.75L16 3"
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
    <svg className={className} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.2279 14.8334L1.50037 14.8334C1.04013 14.8334 0.667035 15.2065 0.667035 15.6667C0.667035 16.1269 1.04013 16.5 1.50037 16.5L12.8945 16.5L11.2279 14.8334Z"
        fill="#878C99"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2.33268 5.93927L2.33268 11.1667C2.33268 12.2713 3.22811 13.1667 4.33268 13.1667L9.56016 13.1667L8.06016 11.6667L4.33268 11.6667C4.05654 11.6667 3.83268 11.4429 3.83268 11.1667L3.83268 7.43927L2.33268 5.93927ZM14.166 10.6369L14.166 5.16675C14.166 4.8906 13.9422 4.66675 13.666 4.66675L8.19589 4.66675L6.69589 3.16675L13.666 3.16675C14.7706 3.16675 15.666 4.06218 15.666 5.16675L15.666 11.1667C15.666 11.4522 15.6062 11.7237 15.4985 11.9693L14.166 10.6369Z"
        fill="#878C99"
      />
      <path
        d="M1.5 1.50006L16.5 16.5001"
        stroke="#E11D48"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
