export function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_17398_782)">
        <path
          d="M19.2293 9C20.1562 9.00001 20.8612 9.83278 20.7088 10.7471L19.2781 19.3291C19.1173 20.2933 18.283 21 17.3055 21H6.69416C5.71662 21 4.88235 20.2933 4.7215 19.3291L3.29084 10.7471C3.13848 9.83289 3.8436 9.00021 4.77033 9H19.2293ZM9.95002 12.5C9.12179 12.5002 8.45002 13.1717 8.45002 14C8.45002 14.8283 9.12179 15.4998 9.95002 15.5H13.95L14.1033 15.4922C14.8597 15.4154 15.45 14.7767 15.45 14C15.45 13.2233 14.8597 12.5846 14.1033 12.5078L13.95 12.5H9.95002Z"
          fill="currentColor"
        />
        <rect x="2" y="3" width="20" height="4" rx="1" fill="currentColor" />
      </g>
      <defs>
        <clipPath id="clip0_17398_782">
          <rect width="24" height="24" fill="currentColor" />
        </clipPath>
      </defs>
    </svg>
  );
}

export function UnarchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_17398_66731)">
        <path
          d="M19.2027 10C20.1385 10 20.8456 10.8478 20.6782 11.7686L19.2984 19.3574C19.1254 20.3084 18.2972 21 17.3306 21H6.66945C5.70287 21 4.87458 20.3084 4.70167 19.3574L3.32179 11.7686C3.15438 10.8478 3.86152 10 4.79738 10H10.9995V16C10.9995 16.5521 11.4475 16.9997 11.9995 17C12.5518 17 12.9995 16.5523 12.9995 16V10H19.2027Z"
          fill="currentColor"
        />
        <rect x="11" y="4" width="2" height="6" fill="currentColor" />
        <path
          d="M15.5 6.5L12 3L8.5 6.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <defs>
        <clipPath id="clip0_17398_66731">
          <rect width="24" height="24" fill="currentColor" />
        </clipPath>
      </defs>
    </svg>
  );
}
