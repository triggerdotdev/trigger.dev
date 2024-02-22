export function TaskIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.0711 0.585818C8.29001 -0.195272 7.02361 -0.195273 6.24252 0.585818L0.585818 6.24252C-0.195272 7.02361 -0.195273 8.29001 0.585818 9.0711L6.24252 14.7278C7.02361 15.5089 8.29001 15.5089 9.0711 14.7278L14.7278 9.0711C15.5089 8.29001 15.5089 7.02361 14.7278 6.24252L9.0711 0.585818ZM6.85833 4.07179L4.29833 11.1718H5.65833L6.24833 9.49179H9.05833L9.64833 11.1718H11.0083L8.44833 4.07179H6.85833ZM8.67833 8.38179H6.62833L7.65833 5.38179L8.67833 8.38179Z"
      />

      <g clipPath="url(#clip0_8651_301570)">
        <path
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M16 0H0V16H16V0ZM10.8099 6.05039V4.90039H5.18994V6.05039H7.33994V12.0004H8.65994V6.05039H10.8099Z"
        />
      </g>
      <defs>
        <clipPath id="clip0_8651_301570">
          <path
            d="M0 2C0 0.895431 0.895431 0 2 0H14C15.1046 0 16 0.895431 16 2V14C16 15.1046 15.1046 16 14 16H2C0.895431 16 0 15.1046 0 14V2Z"
            fill="white"
          />
        </clipPath>
      </defs>
    </svg>
  );
}
