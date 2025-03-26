export function RunFunctionIcon({ className }: { className?: string }) {
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
        d="M9.25 7C8.55964 7 8 7.55964 8 8.25V12.7961V13V14V16.5397C8 17.0692 8.4293 17.4985 8.95887 17.4985C9.48196 17.4985 9.90853 17.0793 9.91759 16.5563L9.96185 14H12.6009L14.434 17.0485C14.7036 17.4968 15.2827 17.6463 15.7356 17.3846C16.1941 17.1196 16.3511 16.5331 16.0861 16.0746L14.615 13.5286C15.4479 12.9956 16 12.0623 16 11V10C16 8.34315 14.6569 7 13 7H9.25ZM10 12V9H13C13.5523 9 14 9.44772 14 10V11C14 11.5523 13.5523 12 13 12H10Z"
        fill="currentColor"
      />
    </svg>
  );
}
