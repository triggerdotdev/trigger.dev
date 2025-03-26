export function MiddlewareIcon({ className }: { className?: string }) {
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
        d="M8.72775 14.8717V11.1087C8.72775 10.4761 9.24051 9.96338 9.87303 9.96338C10.5056 9.96338 11.0183 10.4761 11.0183 11.1087V15.5262V16.5079H12.9817V15.5262V11.1087C12.9817 10.4761 13.4944 9.96334 14.1269 9.96334C14.7594 9.96334 15.2722 10.4761 15.2722 11.1086V15.5262V16.5079H17.2356V15.5262V11.1086C17.2356 9.39177 15.8438 8 14.1269 8C13.3041 8 12.556 8.31966 12 8.84155C11.4439 8.31968 10.6958 8.00004 9.87303 8.00004C9.46858 8.00004 9.08217 8.07728 8.72775 8.21781V8.00004H6.7644V8.98171V11.1087V14.8717V15.5262V15.8534V16.5079H8.72775V15.8534V15.5262V14.8717Z"
        fill="currentColor"
      />
    </svg>
  );
}
