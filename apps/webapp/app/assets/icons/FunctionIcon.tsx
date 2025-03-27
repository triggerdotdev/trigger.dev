export function FunctionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="2.5"
        y="2.5"
        width="19"
        height="19"
        rx="2.5"
        stroke="currentColor"
        strokeOpacity={0.5}
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14.9987 7.99477C13.8955 7.99477 13.0012 8.88907 13.0012 9.99225V10.6649H14.3363H15.3375V12.6675H14.3363H13.0012V14.0084C13.0012 16.2171 11.2107 18.0077 9.0019 18.0077H8.00061V16.0051H9.0019C10.1047 16.0051 10.9986 15.1111 10.9986 14.0084V12.6675H9.66357H8.66228V10.6649H9.66357H10.9986V9.99225C10.9986 7.78308 12.7895 5.99219 14.9987 5.99219H16V7.99477H14.9987Z"
        fill="currentColor"
      />
    </svg>
  );
}
