export function TaskIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g clipPath="url(#clip0_9221_99732)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M16 0H0V16H16V0ZM10.8901 5.73995V4.44995H5.11011V5.73995H7.23011V11.55H8.77011V5.73995H10.8901Z"
          fill="currentColor"
        />
      </g>
      <defs>
        <clipPath id="clip0_9221_99732">
          <path
            d="M0 2C0 0.895431 0.895431 0 2 0H14C15.1046 0 16 0.895431 16 2V14C16 15.1046 15.1046 16 14 16H2C0.895431 16 0 15.1046 0 14V2Z"
            fill="white"
          />
        </clipPath>
      </defs>
    </svg>
  );
}
