export function DevEnvironmentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_15347_71059)">
        <circle cx="7" cy="7" r="2" fill="currentColor" />
        <path
          d="M4.5 0.75H2.75C1.64543 0.75 0.75 1.64543 0.75 2.75V4.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M13.25 4.5L13.25 2.75C13.25 1.64543 12.3546 0.75 11.25 0.75L9.5 0.75"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9.5 13.25L11.25 13.25C12.3546 13.25 13.25 12.3546 13.25 11.25L13.25 9.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M0.75 9.5L0.75 11.25C0.75 12.3546 1.64543 13.25 2.75 13.25L4.5 13.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <defs>
        <clipPath id="clip0_15347_71059">
          <rect width="14" height="14" fill="currentColor" />
        </clipPath>
      </defs>
    </svg>
  );
}

export function ProdEnvironmentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="0.75"
        y="0.75"
        width="12.5"
        height="12.5"
        rx="3.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g clipPath="url(#clip0_15515_83281)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M7.34731 4.15348C7.21887 3.84467 6.78141 3.84467 6.65298 4.15348L5.92066 5.91419L4.01982 6.06658C3.68644 6.0933 3.55126 6.50935 3.80526 6.72693L5.2535 7.96749L4.81104 9.82238C4.73344 10.1477 5.08735 10.4048 5.37277 10.2305L7.00014 9.23651L8.62752 10.2305C8.91294 10.4048 9.26685 10.1477 9.18925 9.82238L8.74679 7.96749L10.195 6.72693C10.449 6.50935 10.3138 6.0933 9.98046 6.06658L8.07963 5.91419L7.34731 4.15348Z"
          fill="currentColor"
        />
      </g>
      <defs>
        <clipPath id="clip0_15515_83281">
          <rect width="8" height="8" fill="currentColor" transform="translate(3 3)" />
        </clipPath>
      </defs>
    </svg>
  );
}

export function DeployedEnvironmentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="0.75"
        y="0.75"
        width="12.5"
        height="12.5"
        rx="3.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </svg>
  );
}
