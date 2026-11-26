// Icons copied from the dashboard's rendered DOM (.claude/skills/docs-dashboard-figures/capture.js).
// Generated once; edit by hand. Each takes the className its dashboard usage passes.
type P = { className?: string };

// Stock heroicons, as the dashboard imports them (same package version as the webapp).
export {
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowUturnLeftIcon,
  ArrowsPointingOutIcon,
  ArrowsRightLeftIcon as CompareIcon,
  BoltIcon as TriggerIcon,
  BookOpenIcon as BookIcon,
  CalendarIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpDownIcon,
  ChevronUpIcon,
  ClipboardIcon as ClipboardSolidIcon,
  ClockIcon,
  CloudArrowDownIcon,
  CpuChipIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
  LockClosedIcon,
  MagnifyingGlassIcon as SearchIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  PlusIcon,
  RectangleStackIcon,
  Squares2X2Icon,
  StarIcon as StarSolidIcon,
  TrashIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
export { Squares2X2Icon as Squares2X2OutlineIcon, StarIcon } from "@heroicons/react/24/outline";
export { CheckIcon, EllipsisVerticalIcon } from "@heroicons/react/24/solid";

// ---- Run page: trace tree, timeline, inspector (runs/v3/RunIcon.tsx and the run route) ----

/** primitives/BreadcrumbIcon.tsx */
export const BreadcrumbIcon = ({ className }: P) => (
  <svg
    className={className}
    width="9"
    height="20"
    viewBox="0 0 9 26"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <line
      x1="9"
      y1="0.7"
      x2="0.7"
      y2="25"
      strokeWidth="1.4"
      stroke="currentColor"
      strokeLinecap="round"
    />
  </svg>
);

/** assets/icons/TaskIcon.tsx */
export const TaskIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="11" y="16" width="2" height="7" rx="1" fill="currentColor" />
    <rect x="11" y="1" width="2" height="7" rx="1" fill="currentColor" />
    <rect
      x="13"
      y="11"
      width="2"
      height="12"
      rx="1"
      transform="rotate(90 13 11)"
      fill="currentColor"
    />
    <rect
      x="23"
      y="11"
      width="2"
      height="7"
      rx="1"
      transform="rotate(90 23 11)"
      fill="currentColor"
    />
    <rect
      x="4.92758"
      y="20.4867"
      width="2"
      height="12.0018"
      rx="1"
      transform="rotate(-135 4.92758 20.4867)"
      fill="currentColor"
    />
    <rect
      x="15.3185"
      y="10.0958"
      width="2"
      height="6.99687"
      rx="1"
      transform="rotate(-135 15.3185 10.0958)"
      fill="currentColor"
    />
    <rect
      x="20.3488"
      y="18.9346"
      width="2"
      height="6.99653"
      rx="1"
      transform="rotate(135 20.3488 18.9346)"
      fill="currentColor"
    />
    <rect
      x="13.4161"
      y="12.002"
      width="2"
      height="11.9956"
      rx="1"
      transform="rotate(135 13.4161 12.002)"
      fill="currentColor"
    />
  </svg>
);

/** assets/icons/AttemptIcon.tsx */
export const AttemptIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
    <rect width="6" height="2" rx="1" transform="matrix(1 0 0 -1 9 15)" fill="currentColor" />
    <rect
      width="2.48444"
      height="2"
      rx="1"
      transform="matrix(1 0 0 -1 10.8042 9)"
      fill="currentColor"
    />
    <path
      d="M12.125 7.06332C11.6119 6.88324 11.0493 7.14809 10.8613 7.65823L7.70722 16.2127C7.52479 16.7075 7.77801 17.2565 8.27281 17.4389C8.7645 17.6202 9.31041 17.3713 9.49607 16.8813L12.7262 8.35528C12.9243 7.83221 12.6528 7.24858 12.125 7.06332Z"
      fill="currentColor"
    />
    <path
      d="M11.9626 7.06332C12.4757 6.88324 13.0383 7.14809 13.2264 7.65823L16.3804 16.2127C16.5628 16.7075 16.3096 17.2565 15.8148 17.4389C15.3231 17.6202 14.7772 17.3713 14.5915 16.8813L11.3614 8.35528C11.1633 7.83221 11.4349 7.24858 11.9626 7.06332Z"
      fill="currentColor"
    />
  </svg>
);

/** assets/icons/RunFunctionIcon.tsx (run()) */
export const RunFunctionIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 8H10V12V16.5159H12V12C12 10.8954 12.8954 10 14 10H15.5V8H14C13.2714 8 12.5883 8.19479 12 8.53513V8Z"
      fill="currentColor"
    />
  </svg>
);

/** assets/icons/InfoIcon.tsx (a log line) */
export const InfoIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="3" width="18" height="18" rx="9" stroke="currentColor" strokeWidth="2" />
    <path
      d="M9.90005 11.7C9.90005 11.2029 10.303 10.8 10.8 10.8H11.1041C12.4476 10.8 13.4455 12.044 13.1541 13.3555L12.6031 15.8348C12.5615 16.0222 12.704 16.1999 12.896 16.1999H13.2C13.6971 16.1999 14.1 16.6029 14.1 17.0999C14.1 17.597 13.6971 17.9999 13.2 17.9999H12.896C11.5525 17.9999 10.5545 16.7558 10.846 15.4444L11.397 12.965C11.4386 12.7777 11.296 12.5999 11.1041 12.5999H10.8C10.303 12.5999 9.90005 12.197 9.90005 11.7Z"
      fill="currentColor"
    />
    <path
      d="M12 8.39998C12.6628 8.39998 13.2 7.86273 13.2 7.19999C13.2 6.53725 12.6628 6 12 6C11.3373 6 10.8 6.53725 10.8 7.19999C10.8 7.86273 11.3373 8.39998 12 8.39998Z"
      fill="currentColor"
    />
  </svg>
);

/** assets/icons/PauseIcon.tsx (wait.for()) */
export const PauseIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12ZM8 8.25C8 7.55964 8.55964 7 9.25 7C9.94036 7 10.5 7.55964 10.5 8.25V15.75C10.5 16.4404 9.94036 17 9.25 17C8.55964 17 8 16.4404 8 15.75V8.25ZM14.75 7C14.0596 7 13.5 7.55964 13.5 8.25V15.75C13.5 16.4404 14.0596 17 14.75 17C15.4404 17 16 16.4404 16 15.75V8.25C16 7.55964 15.4404 7 14.75 7Z"
      fill="currentColor"
    />
  </svg>
);

/** WarmStarts.tsx: the snowflake on an attempt that started warm */
export const WarmStartIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M12.0016 2C12.7127 2 13.2872 2.55859 13.2872 3.25V4.42578L13.8898 3.83984C14.2675 3.47266 14.8782 3.47266 15.2518 3.83984C15.6255 4.20703 15.6295 4.80078 15.2518 5.16406L13.2832 7.07812V9.82422L15.75 8.42578L16.4611 5.84375C16.5977 5.34375 17.1281 5.04688 17.6423 5.17969C18.1566 5.3125 18.4619 5.82813 18.3253 6.32813L18.1164 7.08203L19.0645 6.54297C19.6792 6.19531 20.4667 6.39844 20.8243 6.99219C21.1818 7.58594 20.9769 8.35547 20.3622 8.70313L19.3458 9.28125L20.2176 9.50781C20.7319 9.64062 21.0372 10.1563 20.9006 10.6563C20.764 11.1563 20.2337 11.4531 19.7194 11.3203L16.9995 10.6133L14.5528 12L16.9995 13.3867L19.7194 12.6797C20.2337 12.5469 20.764 12.8437 20.9006 13.3437C21.0372 13.8437 20.7319 14.3594 20.2176 14.4922L19.3458 14.7188L20.3622 15.2969C20.9769 15.6445 21.1818 16.4102 20.8243 17.0078C20.4667 17.6055 19.6792 17.8047 19.0645 17.457L18.1164 16.918L18.3253 17.6719C18.4619 18.1719 18.1566 18.6875 17.6423 18.8203C17.1281 18.9531 16.5977 18.6563 16.4611 18.1563L15.75 15.5742L13.2872 14.1758V16.9219L15.2558 18.8359C15.6335 19.2031 15.6335 19.7969 15.2558 20.1602C14.8782 20.5234 14.2675 20.5273 13.8939 20.1602L13.2912 19.5742V20.75C13.2912 21.4414 12.7167 22 12.0056 22C11.2945 22 10.7199 21.4414 10.7199 20.75V19.5742L10.1173 20.1602C9.73964 20.5273 9.12896 20.5273 8.75532 20.1602C8.38169 19.793 8.37767 19.1992 8.75532 18.8359L10.724 16.9219V14.1758L8.25714 15.5742L7.54602 18.1563C7.40942 18.6563 6.87909 18.9531 6.36484 18.8203C5.85058 18.6875 5.54524 18.1719 5.68184 17.6719L5.89076 16.918L4.93456 17.4531C4.31987 17.8008 3.53241 17.5977 3.17485 17.0039C2.81728 16.4102 3.02619 15.6406 3.63687 15.293L4.65333 14.7148L3.78151 14.4883C3.26725 14.3555 2.96191 13.8398 3.09851 13.3398C3.23511 12.8398 3.76544 12.543 4.27969 12.6758L6.99962 13.3828L9.45037 12L7.00364 10.6133L4.28371 11.3203C3.76945 11.4531 3.23913 11.1563 3.10253 10.6563C2.96593 10.1563 3.27127 9.64062 3.78552 9.50781L4.65735 9.28125L3.64089 8.70313C3.02619 8.35547 2.82129 7.58984 3.17886 6.99609C3.53643 6.40234 4.32389 6.19922 4.93858 6.54688L5.88674 7.08594L5.67783 6.33203C5.54123 5.83203 5.84657 5.31641 6.36082 5.18359C6.87508 5.05078 7.4054 5.34766 7.542 5.84766L8.25312 8.42969L10.7159 9.82422V7.07812L8.74729 5.16406C8.36963 4.79688 8.36963 4.20312 8.74729 3.83984C9.12495 3.47656 9.73562 3.47266 10.1093 3.83984L10.7119 4.42578L10.7159 3.25C10.7159 2.55859 11.2904 2 12.0016 2Z"
      fill="currentColor"
    />
  </svg>
);

/** assets/icons/DropdownIcon.tsx: up and down chevrons (select triggers, the trace's Shortcuts menu) */
export const DropdownIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M7.5 9L12 5L16.5 9"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7.5 15L12 19L16.5 15"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** assets/icons/TextWrapIcon.tsx (CodeBlock) */
export const TextWrapIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M3 3V21"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M21 21V3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7 7H14C15.6569 7 17 8.34315 17 10V13C17 14.6569 15.6569 16 14 16H9"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11 13L8 16L11 19"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** lucide ClipboardIcon (CodeBlock, CopyTextLink) */
export const ClipboardIcon = ({ className }: P) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </svg>
);

/** runs/v3/RunTag.tsx: the tag's pointed left end */
export const TagLeftIcon = ({ className }: P) => (
  <svg
    width="9"
    height="25"
    viewBox="0 0 9 25"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <path
      d="M8.51694 0.5H10.5V24.5H8.51694C7.17088 24.5 5.94409 23.7281 5.36161 22.5146L1.69703 14.88C0.974863 13.3755 0.974863 11.6245 1.69703 10.12L5.3616 2.48544C5.94409 1.27194 7.17088 0.5 8.51694 0.5Z"
      vectorEffect="non-scaling-stroke"
      className="fill-background-bright stroke-grid-bright"
    />
  </svg>
);

export const AccountIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <circle cx="12" cy="9.5" r="2.5" stroke="currentColor" strokeWidth="2" />
    <path
      d="M6 19C7.00156 16.6478 9.32233 15 12.0254 15C14.6837 15 16.9724 16.5938 18 18.884"
      stroke="currentColor"
      strokeWidth="2"
    />
  </svg>
);

export const FolderIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M20 8C20 6.96907 19.1643 6.13333 18.1333 6.13333H12.3602C11.8439 6.13333 11.3476 5.93367 10.9751 5.57611L9.91378 4.55723C9.54132 4.19967 9.04502 4 8.52871 4H6C4.89543 4 4 4.89543 4 6V8"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <path
      d="M3.24676 13.2209C3.11513 12.0361 4.04251 11 5.23453 11H18.7655C19.9575 11 20.8849 12.0361 20.7532 13.2209L20.1977 18.2209C20.0851 19.2337 19.229 20 18.2099 20H5.79009C4.77099 20 3.91486 19.2337 3.80232 18.2209L3.24676 13.2209Z"
      stroke="currentColor"
      strokeWidth="2"
    />
  </svg>
);

export const DevelopmentIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="10" cy="10" r="2" fill="currentColor" />
    <path
      d="M7 3H5C3.89543 3 3 3.89543 3 5V7"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M17 7L17 5C17 3.89543 16.1046 3 15 3L13 3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M13 17L15 17C16.1046 17 17 16.1046 17 15L17 13"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3 13L3 15C3 16.1046 3.89543 17 5 17L7 17"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const TasksIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
    <rect
      width="8.993"
      height="2"
      rx="1"
      transform="matrix(1 0 0 -1 7.5035 9)"
      fill="currentColor"
    />
    <path
      d="M11 8.49536L11 16.4954C11 17.0476 11.4477 17.4954 12 17.4954C12.5523 17.4954 13 17.0476 13 16.4954L13 8.49536L11 8.49536Z"
      fill="currentColor"
    />
  </svg>
);

export const RunsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M7 6.5L19 6.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3 17.5L13 17.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M16 11L20.5 6.5L16 2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10 22L14.5 17.5L10 13"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const SessionsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5.42975 3.52374C7.56942 3.17905 9.76406 3 12 3C14.2359 3 16.4306 3.17905 18.5702 3.52374C20.0066 3.75513 21 5.01325 21 6.42589V13.5741C21 14.9868 20.0066 16.2449 18.5702 16.4763C16.8747 16.7494 15.1447 16.9185 13.3869 16.977C13.1832 16.9837 12.9952 17.0654 12.8594 17.2013L9.28032 20.7803C9.06582 20.9948 8.74323 21.059 8.46298 20.9429C8.18272 20.8268 7.99999 20.5534 7.99999 20.25V16.8073C7.13516 16.7236 6.27812 16.6129 5.42975 16.4763C3.99338 16.2449 2.99998 14.9868 2.99998 13.5741V6.42589C2.99998 5.01325 3.99337 3.75513 5.42975 3.52374Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 6C12.3443 6 12.6501 6.22034 12.7589 6.54702L13.1795 7.8086C13.3387 8.28637 13.7136 8.66127 14.1914 8.82053L15.453 9.24106C15.7797 9.34995 16 9.65566 16 10C16 10.3443 15.7797 10.6501 15.453 10.7589L14.1914 11.1795C13.7136 11.3387 13.3387 11.7136 13.1795 12.1914L12.7589 13.453C12.6501 13.7797 12.3443 14 12 14C11.6557 14 11.3499 13.7797 11.2411 13.453L10.8205 12.1914C10.6613 11.7136 10.2864 11.3387 9.8086 11.1795L8.54702 10.7589C8.22034 10.6501 8 10.3443 8 10C8 9.65566 8.22034 9.34995 8.54702 9.24106L9.8086 8.82053C10.2864 8.66127 10.6613 8.28637 10.8205 7.8086L11.2411 6.54702C11.3499 6.22034 11.6557 6 12 6Z"
      fill="currentColor"
    />
  </svg>
);

export const WebhooksIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="7" r="1.75" fill="currentColor" />
    <circle cx="7" cy="16" r="1.75" fill="currentColor" />
    <circle cx="17" cy="16" r="1.75" fill="currentColor" />
    <path
      d="M16 7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7C8 8.14562 8.48161 9.17875 9.25341 9.90798C9.65459 10.287 9.83991 10.8882 9.57187 11.3706L8.94292 12.5027L7 16M12 7L13.9429 10.4973L14.571 11.6278C14.8394 12.1109 15.4487 12.2704 15.9833 12.1304C16.3079 12.0453 16.6487 12 17 12C19.2091 12 21 13.7909 21 16C21 18.2091 19.2091 20 17 20C16.2949 20 15.6323 19.8175 15.0571 19.4973M17 16H12C11.4477 16 11.0128 16.4547 10.8766 16.9899C10.4361 18.7202 8.86748 20 7 20C4.79086 20 3 18.2091 3 16C3 14.496 3.83007 13.1859 5.05708 12.5027"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const PromptsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M6 2C6.34434 2 6.65005 2.22034 6.75895 2.54702L7.17947 3.8086C7.33873 4.28637 7.71363 4.66127 8.1914 4.82053L9.45298 5.24105C9.77966 5.34995 10 5.65566 10 6C10 6.34434 9.77966 6.65005 9.45298 6.75895L8.1914 7.17947C7.71363 7.33873 7.33873 7.71363 7.17947 8.1914L6.75895 9.45298C6.65005 9.77966 6.34434 10 6 10C5.65566 10 5.34995 9.77966 5.24105 9.45298L4.82053 8.1914C4.66127 7.71363 4.28637 7.33873 3.8086 7.17947L2.54702 6.75895C2.22034 6.65005 2 6.34434 2 6C2 5.65566 2.22034 5.34995 2.54702 5.24105L3.8086 4.82053C4.28637 4.66127 4.66127 4.28637 4.82053 3.8086L5.24105 2.54702C5.34995 2.22034 5.65566 2 6 2Z"
      fill="currentColor"
    />
    <path
      d="M18.7573 3.6275L20.3732 5.24335C21.1542 6.0244 21.1542 7.29073 20.3732 8.07178L9.7203 18.7246C9.57776 18.8671 9.39569 18.9631 9.19757 19.0002L4.03376 19.9669L5.00051 14.8031C5.03763 14.6051 5.13358 14.4229 5.27603 14.2804L15.9289 3.6275C16.7099 2.84645 17.9763 2.84645 18.7573 3.6275Z"
      stroke="currentColor"
      strokeWidth="2"
    />
    <line x1="17.6464" y1="10.3536" x2="13.6464" y2="6.35355" stroke="currentColor" />
  </svg>
);

export const ModelsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M11.5352 3.37305C11.8262 3.22036 12.174 3.22033 12.4649 3.37305L19.9913 7.32324C20.3204 7.49599 20.5264 7.83734 20.5265 8.20898V15.791C20.5264 16.1627 20.3204 16.504 19.9913 16.6768L12.4649 20.627C12.174 20.7797 11.8262 20.7796 11.5352 20.627L4.00888 16.6768C3.67978 16.504 3.47374 16.1627 3.47372 15.791V8.20898C3.47374 7.83731 3.67978 7.49598 4.00888 7.32324L11.5352 3.37305Z"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M4.44721 7.10557C3.95324 6.85858 3.35256 7.05881 3.10557 7.55279C2.85858 8.04676 3.05881 8.64744 3.55279 8.89443L4 8L4.44721 7.10557ZM12 20H13V12H12H11V20H12ZM12 12L12.4472 12.8944L20.4472 8.89443L20 8L19.5528 7.10557L11.5528 11.1056L12 12ZM4 8L3.55279 8.89443L11.5528 12.8944L12 12L12.4472 11.1056L4.44721 7.10557L4 8Z"
      fill="currentColor"
    />
  </svg>
);

export const LogsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="4" cy="12" r="1" fill="currentColor" />
    <circle cx="4" cy="6" r="1" fill="currentColor" />
    <circle cx="4" cy="18" r="1" fill="currentColor" />
    <path
      d="M7.5 12L10.5 12"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7.5 6L10.5 6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7.5 18H10.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 6L20 6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 12L20 12"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 18H20"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const ErrorsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M18 17L21 19"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M6 17L3 19"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M18 13H21"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M18 9L21 7"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M8 8H16C17.1046 8 18 8.89543 18 10V15C18 18.3137 15.3137 21 12 21C8.68629 21 6 18.3137 6 15V10C6 8.89543 6.89543 8 8 8Z"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M3 13H6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 21V14"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M16 7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <path
      d="M6 9L3 7"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const QueryIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
    <path
      d="M10 9L7 12L10 15"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 15L17 12L14 9"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const ConcurrencyIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="10" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
    <line
      x1="5"
      y1="7"
      x2="19"
      y2="7"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <line
      x1="7"
      y1="4"
      x2="17"
      y2="4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

export const DashboardsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M9 5C9 3.89543 9.89543 3 11 3H13C14.1046 3 15 3.89543 15 5V21H9V5Z"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M15 13C15 11.8954 15.8954 11 17 11H19C20.1046 11 21 11.8954 21 13V20C21 20.5523 20.5523 21 20 21H15V13Z"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M3 10C3 8.89543 3.89543 8 5 8H7C8.10457 8 9 8.89543 9 10V21H4C3.44772 21 3 20.5523 3 20V10Z"
      stroke="currentColor"
      strokeWidth="2"
    />
  </svg>
);

export const TreeConnectorIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 20 20" fill="none">
    <line x1="10" y1="-6" x2="10" y2="26" stroke="currentColor" strokeWidth="1" />
    <line x1="10" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth="1" />
  </svg>
);

export const DeploysIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
    <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="2" />
    <circle cx="17.25" cy="8" r="1.25" fill="currentColor" />
    <circle cx="17.25" cy="16" r="1.25" fill="currentColor" />
  </svg>
);

export const PreviewBranchesIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M2.23059 7C1.65409 6.99967 1.30545 6.36259 1.61634 5.87695L3.88489 2.33301C4.17195 1.88466 4.82727 1.88472 5.11438 2.33301L7.38294 5.87695C7.69386 6.36265 7.34531 6.99982 6.76868 7L2.23059 7Z"
      fill="currentColor"
    />
    <path
      d="M3.5 6H5.5V15C5.5 15.5523 5.05228 16 4.5 16C3.94772 16 3.5 15.5523 3.5 15V6Z"
      fill="currentColor"
    />
    <path
      d="M13.5 7V7.5C13.5 9.15685 12.1569 10.5 10.5 10.5H7.5C5.84315 10.5 4.5 11.8431 4.5 13.5V15"
      stroke="currentColor"
      strokeWidth="2"
    />
    <circle cx="13.5" cy="5" r="2" stroke="currentColor" strokeWidth="2" />
  </svg>
);

export const RegionsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12.0232" r="9" stroke="currentColor" strokeWidth="2" />
    <path
      d="M12 3C12.7978 3 13.789 3.67288 14.6406 5.37598C15.4624 7.0195 16 9.36016 16 12C16 14.6398 15.4624 16.9805 14.6406 18.624C13.789 20.3271 12.7978 21 12 21C11.2022 21 10.211 20.3271 9.35938 18.624C8.53761 16.9805 8 14.6398 8 12C8 9.36016 8.53761 7.0195 9.35938 5.37598C10.211 3.67288 11.2022 3 12 3Z"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M4 9H20"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M4 15H20"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const ApiKeysIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="15.5" cy="8.5" r="1.5" fill="currentColor" />
    <path
      d="M3.50164 20.9983L7.30857 20.9859C7.44061 20.9854 7.56712 20.9328 7.66049 20.8394L10.3536 18.1464C10.4473 18.0526 10.5 17.9254 10.5 17.7928L10.5 15.6098C10.5 15.2943 10.7887 15.0577 11.0981 15.1195L12.7376 15.4474C12.9015 15.4802 13.071 15.4289 13.1892 15.3107L14.5771 13.9228C14.8772 13.9735 15.1855 13.9999 15.5 13.9999C18.5376 13.9999 21 11.5375 21 8.49993C21 5.46236 18.5376 2.99993 15.5 2.99993C12.4624 2.99993 10 5.46236 10 8.49993C10 8.96086 10.0567 9.40856 10.1635 9.83642L3.14645 16.8535C3.05268 16.9472 3 17.0744 3 17.207L3 20.4983C3 20.7751 3.22486 20.9992 3.50164 20.9983Z"
      stroke="currentColor"
      strokeWidth="2"
    />
  </svg>
);

export const EnvironmentVariablesIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
    <circle cx="9.5" cy="11.5" r="2.5" stroke="currentColor" strokeWidth="2" />
    <path
      d="M14 18.5C14 16.0147 11.9853 14 9.5 14C7.01472 14 5 16.0147 5 18.5"
      stroke="currentColor"
      strokeWidth="2"
    />
    <rect x="16" y="8" width="5" height="2" rx="1" fill="currentColor" />
    <rect x="16" y="12" width="5" height="2" rx="1" fill="currentColor" />
  </svg>
);

export const WaitpointTokensIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M15.1718 3.00043C15.4369 3.00049 15.6908 3.10564 15.8782 3.29305L20.7066 8.1216C20.8941 8.30914 21.0003 8.56363 21.0003 8.82885L20.9996 15.1718C20.9996 15.4369 20.8944 15.6907 20.707 15.8782L15.8781 20.7075C15.6906 20.8947 15.4362 21.0002 15.1712 21.0002L8.82829 20.9996C8.5632 20.9996 8.30933 20.8944 8.12184 20.707L3.29315 15.8794C3.10561 15.6918 2.99982 15.4364 2.99982 15.1712L3.00045 8.82827C3.00052 8.5632 3.10567 8.30929 3.29307 8.12182L8.12162 3.2935C8.30915 3.10597 8.56365 2.99981 8.82886 2.9998L15.1718 3.00043Z"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M8.49998 9C8.49998 8.44772 8.9477 8 9.49998 8H9.99998C10.5523 8 11 8.44772 11 9V15C11 15.5523 10.5523 16 9.99998 16H9.49998C8.9477 16 8.49998 15.5523 8.49998 15L8.49998 9Z"
      fill="currentColor"
    />
    <path
      d="M13 9C13 8.44772 13.4477 8 14 8H14.5C15.0523 8 15.5 8.44772 15.5 9V15C15.5 15.5523 15.0523 16 14.5 16H14C13.4477 16 13 15.5523 13 15L13 9Z"
      fill="currentColor"
    />
  </svg>
);

export const BatchesIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="2" />
    <rect x="3" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="2" />
    <rect x="14" y="3" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="2" />
    <rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="2" />
  </svg>
);

export const BulkActionsIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M2.85001 3.82759L4.09139 5.06897L6.16035 3"
      stroke="currentColor"
      strokeWidth="1.65517"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M2.85001 8.82759L4.09139 10.069L6.16035 8"
      stroke="currentColor"
      strokeWidth="1.65517"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M2.85001 13.8276L4.09139 15.069L6.16035 13"
      stroke="currentColor"
      strokeWidth="1.65517"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9 4H15"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9 9H15"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9 14H15"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const AlertsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M15 18C15 19.6569 13.6569 21 12 21C10.3431 21 9 19.6569 9 18"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M12 3C15.4217 3 18.2705 5.63978 18.5762 9.06641C18.7369 10.8684 18.9014 12.5444 19.0156 13.1777C19.1051 13.6742 19.2358 14.3446 19.373 15.0332L19.7715 16.9971C19.7714 16.9973 19.7713 16.9981 19.7705 16.999L19.7695 17H4.23047L4.22949 16.999L4.22852 16.9971C4.46222 15.8599 4.80534 14.1705 4.98438 13.1777C5.09858 12.5444 5.26306 10.8684 5.42383 9.06641C5.72954 5.63978 8.57828 3 12 3Z"
      stroke="currentColor"
      strokeWidth="2"
    />
  </svg>
);

export const LimitsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12.0232" r="9" stroke="currentColor" strokeWidth="2" />
    <path
      d="M12 12L6 18"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IntegrationsIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M10 14V21H4C3.44772 21 3 20.5523 3 20V14H10Z" stroke="currentColor" strokeWidth="2" />
    <path d="M4 7H10V14H3V8C3 7.44772 3.44772 7 4 7Z" stroke="currentColor" strokeWidth="2" />
    <path
      d="M17 14V20C17 20.5523 16.5523 21 16 21H10V14H17Z"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path
      d="M15 3H20C20.5523 3 21 3.44772 21 4V9C21 9.55228 20.5523 10 20 10H14V4C14 3.44772 14.4477 3 15 3Z"
      stroke="currentColor"
      strokeWidth="2"
    />
  </svg>
);

export const StagingIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="10" cy="10" r="2" fill="currentColor" />
    <rect
      x="3"
      y="3"
      width="14"
      height="14"
      rx="3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const PreviewIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="10" cy="10" r="2" fill="currentColor" />
    <rect
      x="3"
      y="3"
      width="14"
      height="14"
      rx="3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const ProductionIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect
      x="3"
      y="3"
      width="14"
      height="14"
      rx="3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10.4174 6.23514C10.263 5.86384 9.73701 5.86384 9.58258 6.23514L8.70207 8.35213L6.4166 8.53536C6.01575 8.56749 5.85322 9.06773 6.15862 9.32934L7.89991 10.8209L7.36792 13.0512C7.27461 13.4423 7.70014 13.7515 8.04332 13.5419L10 12.3467L11.9567 13.5419C12.2999 13.7515 12.7254 13.4423 12.6321 13.0512L12.1001 10.8209L13.8414 9.32934C14.1468 9.06773 13.9842 8.56749 13.5834 8.53536L11.2979 8.35213L10.4174 6.23514Z"
      fill="currentColor"
    />
  </svg>
);

export const CloseIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const ToggleArrowIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 6 5" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M3.43301 4.25C3.24056 4.58333 2.75944 4.58333 2.56699 4.25L0.834937 1.25C0.642486 0.916667 0.883049 0.5 1.26795 0.5L4.73205 0.5C5.11695 0.5 5.35751 0.916667 5.16506 1.25L3.43301 4.25Z"
      fill="currentColor"
    />
  </svg>
);

// Copied from apps/webapp/app/assets/icons and @heroicons/react/20/solid.

export const TaskSmallIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="9" y="14" width="2" height="4" rx="1" fill="currentColor" />
    <rect x="9" y="2" width="2" height="4" rx="1" fill="currentColor" />
    <rect
      x="11"
      y="9"
      width="2"
      height="9"
      rx="1"
      transform="rotate(90 11 9)"
      fill="currentColor"
    />
    <rect
      x="18"
      y="9"
      width="2"
      height="4"
      rx="1"
      transform="rotate(90 18 9)"
      fill="currentColor"
    />
    <rect
      x="5.0531"
      y="16.3611"
      width="2"
      height="8.99589"
      rx="1"
      transform="rotate(-135 5.0531 16.3611)"
      fill="currentColor"
    />
    <rect
      x="13.3185"
      y="8.09583"
      width="2"
      height="4"
      rx="1"
      transform="rotate(-135 13.3185 8.09583)"
      fill="currentColor"
    />
    <rect
      x="16.2304"
      y="14.8163"
      width="2"
      height="4.00064"
      rx="1"
      transform="rotate(135 16.2304 14.8163)"
      fill="currentColor"
    />
    <rect
      x="11.4161"
      y="10.002"
      width="2"
      height="8.99796"
      rx="1"
      transform="rotate(135 11.4161 10.002)"
      fill="currentColor"
    />
  </svg>
);

export const ClockRotateLeftIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M4.01784 10.9999C4.27072 9.07068 5.21806 7.29972 6.68252 6.01856C8.14697 4.73741 10.0282 4.03389 11.9739 4.03971C13.9197 4.04553 15.7966 4.76028 17.2534 6.05017C18.7101 7.34006 19.6469 9.11666 19.8882 11.0474C20.1296 12.9781 19.659 14.9306 18.5645 16.5394C17.4701 18.1482 15.8268 19.303 13.9424 19.7876C12.0579 20.2722 10.0615 20.0534 8.32671 19.1721C6.59196 18.2909 5.23784 16.8076 4.51784 14.9999M4.01784 19.9999L4.01784 14.9999L9.01784 14.9999"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M12 12L12 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M12 12L14 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const BeakerIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M9 10V4H15V10C16.3896 11.737 19.5 15.0137 19.5 17.4324C19.5 19.4768 17.5444 21 15.5 21H8.5C6.45569 21 4.5 19.5444 4.5 17.5C4.5 15.0813 7.6104 11.737 9 10Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <line
      x1="8"
      y1="4"
      x2="16"
      y2="4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <line x1="6" y1="14" x2="18" y2="14" stroke="currentColor" strokeWidth="2" />
  </svg>
);

export const KeyboardEnterIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M12 5H18C19.6569 5 21 6.34315 21 8V13C21 14.6569 19.6569 16 18 16H8"
      stroke="currentColor"
      strokeWidth="2"
    />
    <path d="M2 16L8 12L8 20L2 16Z" fill="currentColor" />
  </svg>
);

/** The AI sparkle keeps its own fills in both themes, as in the dashboard. */
export const AISparkleIcon = ({ className }: P) => (
  <svg
    className={className}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9.14286 4.85718C9.46177 4.85718 9.74205 5.06859 9.82966 5.37523L10.6041 8.08589C10.9431 9.27235 11.8705 10.1998 13.057 10.5388L15.7677 11.3132C16.0743 11.4008 16.2857 11.6811 16.2857 12C16.2857 12.319 16.0743 12.5992 15.7677 12.6868L13.057 13.4613C11.8705 13.8003 10.9431 14.7277 10.6041 15.9142L9.82966 18.6248C9.74205 18.9315 9.46177 19.1429 9.14286 19.1429C8.82394 19.1429 8.54367 18.9315 8.45605 18.6248L7.68158 15.9142C7.34259 14.7277 6.41517 13.8003 5.22871 13.4613L2.51806 12.6868C2.21141 12.5992 2 12.319 2 12C2 11.6811 2.21141 11.4008 2.51806 11.3132L5.22871 10.5388C6.41517 10.1998 7.34259 9.27235 7.68158 8.08589L8.45605 5.37523C8.54367 5.06859 8.82394 4.85718 9.14286 4.85718Z"
      fill="#7655FD"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M17.7143 2C18.0421 2 18.3278 2.22307 18.4072 2.54105L18.6538 3.5272C18.8777 4.42291 19.5771 5.12229 20.4728 5.34622L21.459 5.59276C21.7769 5.67225 22 5.95795 22 6.28571C22 6.61348 21.7769 6.89918 21.459 6.97867L20.4728 7.22521C19.5771 7.44914 18.8777 8.14851 18.6538 9.04423L18.4072 10.0304C18.3278 10.3484 18.0421 10.5714 17.7143 10.5714C17.3865 10.5714 17.1008 10.3484 17.0213 10.0304L16.7748 9.04423C16.5509 8.14852 15.8515 7.44914 14.9558 7.22521L13.9696 6.97867C13.6516 6.89918 13.4286 6.61348 13.4286 6.28571C13.4286 5.95795 13.6516 5.67225 13.9696 5.59276L14.9558 5.34622C15.8515 5.12229 16.5509 4.42291 16.7748 3.5272L17.0213 2.54105C17.1008 2.22307 17.3865 2 17.7143 2Z"
      fill="#D946EF"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M16.2857 14.8572C16.5932 14.8572 16.8661 15.0539 16.9633 15.3456L17.3388 16.472C17.481 16.8986 17.8157 17.2333 18.2423 17.3755L19.3687 17.751C19.6604 17.8482 19.8571 18.1212 19.8571 18.4286C19.8571 18.7361 19.6604 19.009 19.3687 19.1062L18.2423 19.4817C17.8157 19.6239 17.481 19.9586 17.3388 20.3852L16.9633 21.5116C16.8661 21.8033 16.5932 22 16.2857 22C15.9783 22 15.7053 21.8033 15.6081 21.5116L15.2326 20.3852C15.0904 19.9586 14.7557 19.6239 14.3291 19.4817L13.2027 19.1062C12.911 19.009 12.7143 18.7361 12.7143 18.4286C12.7143 18.1212 12.911 17.8482 13.2027 17.751L14.3291 17.3755C14.7557 17.2333 15.0904 16.8986 15.2326 16.472L15.6081 15.3456C15.7053 15.0539 15.9783 14.8572 16.2857 14.8572Z"
      fill="#4F46E5"
    />
  </svg>
);

// The runs table (components/runs/v3/TaskRunsTable.tsx): @heroicons/react/20/solid unless noted.

/** app/assets/icons/MachineIcon.tsx: MachineIcon for the small-1x preset (its own blue fill). */
export const MachineSmall1xIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M16.1875 13C16.6362 13 17 13.3638 17 13.8125V16.1875C17 16.6362 16.6362 17 16.1875 17H3.8125C3.36377 17 3 16.6362 3 16.1875V13.8125C3 13.3638 3.36377 13 3.8125 13H16.1875ZM5 14C4.44772 14 4 14.4477 4 15C4 15.5523 4.44772 16 5 16C5.55228 16 6 15.5523 6 15C6 14.4477 5.55228 14 5 14Z"
      fill="#3B82F6"
    />
    <path
      d="M16.1875 8C16.6362 8 17 8.36377 17 8.8125V11.1875C17 11.6362 16.6362 12 16.1875 12H3.8125C3.36377 12 3 11.6362 3 11.1875V8.8125C3 8.36377 3.36377 8 3.8125 8H16.1875ZM5 9C4.44772 9 4 9.44772 4 10C4 10.5523 4.44772 11 5 11C5.55228 11 6 10.5523 6 10C6 9.44772 5.55228 9 5 9Z"
      fill="currentColor"
      fillOpacity="0.4"
    />
    <path
      d="M16.1875 3C16.6362 3 17 3.36377 17 3.8125V6.1875C17 6.63623 16.6362 7 16.1875 7H3.8125C3.36377 7 3 6.63623 3 6.1875V3.8125C3 3.36377 3.36377 3 3.8125 3H16.1875ZM5 4C4.44772 4 4 4.44772 4 5C4 5.55228 4.44772 6 5 6C5.55228 6 6 5.55228 6 5C6 4.44772 5.55228 4 5 4Z"
      fill="currentColor"
      fillOpacity="0.4"
    />
  </svg>
);

/** app/assets/icons/ArchiveIcon.tsx (its full-size clip path dropped: it clips nothing). */
export const ArchiveIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M19.2293 9C20.1562 9.00001 20.8612 9.83278 20.7088 10.7471L19.2781 19.3291C19.1173 20.2933 18.283 21 17.3055 21H6.69416C5.71662 21 4.88235 20.2933 4.7215 19.3291L3.29084 10.7471C3.13848 9.83289 3.8436 9.00021 4.77033 9H19.2293ZM9.95002 12.5C9.12179 12.5002 8.45002 13.1717 8.45002 14C8.45002 14.8283 9.12179 15.4998 9.95002 15.5H13.95L14.1033 15.4922C14.8597 15.4154 15.45 14.7767 15.45 14C15.45 13.2233 14.8597 12.5846 14.1033 12.5078L13.95 12.5H9.95002Z"
      fill="currentColor"
    />
    <rect x="2" y="3" width="20" height="4" rx="1" fill="currentColor" />
  </svg>
);

/** app/assets/icons/PromoteIcon.tsx */
export const PromoteIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M9.5 15.75H5.25493C4.4265 15.75 3.75493 16.4216 3.75493 17.25V19.741C3.75493 20.5695 4.4265 21.241 5.25493 21.241H18.7582C19.5866 21.241 20.2582 20.5695 20.2582 19.741V17.25C20.2582 16.4216 19.5866 15.75 18.7582 15.75H14.5"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="M9.5 7.75H5.25493C4.4265 7.75 3.75493 8.42157 3.75493 9.25V11.741C3.75493 12.5695 4.4265 13.241 5.25493 13.241H9.5M14.5 7.75002H18.7582C19.5866 7.75002 20.2582 8.42159 20.2582 9.25002V11.741C20.2582 12.5695 19.5866 13.241 18.7582 13.241H14.5"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path d="M12 18L12 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path
      d="M9 5.22892L12 2.75L15 5.22892"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** @tabler/icons-react IconArrowBearRight2 ("Switch to branch"). */
export const ArrowBearRightIcon = ({ className }: P) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 3h5v5" />
    <path d="M20 3l-7.536 7.536a5 5 0 0 0 -1.464 3.534v6.93" />
    <path d="M4 5l4.5 4.5" />
  </svg>
);

/** app/assets/icons/NodejsLogoIcon.tsx (its own green, as the dashboard draws it). */
export const NodejsLogoIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 71 80" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g fill="#5FA04E">
      <path d="M35.625 79.5c-1.081 0-2.09-.288-3.028-.792l-9.59-5.686c-1.442-.792-.721-1.08-.289-1.224 1.947-.648 2.308-.792 4.327-1.944.216-.144.504-.072.72.072l7.356 4.391c.288.144.649.144.865 0l28.77-16.628c.289-.144.433-.431.433-.791V23.714c0-.36-.144-.648-.432-.792L35.986 6.366c-.288-.144-.65-.144-.865 0L6.35 22.922c-.29.144-.434.504-.434.792v33.184c0 .287.145.647.433.791l7.86 4.535c4.254 2.16 6.922-.36 6.922-2.879V26.593c0-.432.36-.864.865-.864h3.678c.432 0 .865.36.865.864v32.752c0 5.687-3.1 8.998-8.509 8.998-1.658 0-2.956 0-6.633-1.8l-7.572-4.319A6.073 6.073 0 0 1 .798 56.97V23.786a6.073 6.073 0 0 1 3.028-5.255l28.77-16.628c1.804-1.008 4.255-1.008 6.058 0l28.77 16.628a6.073 6.073 0 0 1 3.029 5.255V56.97a6.073 6.073 0 0 1-3.029 5.254l-28.77 16.628c-.865.36-1.947.648-3.029.648Z" />
      <path d="M44.567 56.682c-12.62 0-15.215-5.759-15.215-10.654 0-.432.36-.864.865-.864h3.75c.433 0 .793.288.793.72.577 3.815 2.235 5.687 9.879 5.687 6.057 0 8.652-1.368 8.652-4.607 0-1.871-.72-3.24-10.167-4.175-7.86-.792-12.762-2.52-12.762-8.782 0-5.83 4.903-9.285 13.123-9.285 9.23 0 13.772 3.167 14.35 10.077 0 .216-.073.432-.217.648-.144.144-.36.288-.577.288h-3.822a.844.844 0 0 1-.793-.648c-.865-3.96-3.1-5.255-9.013-5.255-6.634 0-7.427 2.304-7.427 4.031 0 2.088.937 2.736 9.879 3.887 8.869 1.152 13.05 2.808 13.05 8.998 0 6.335-5.263 9.934-14.348 9.934Z" />
    </g>
  </svg>
);

/** @tabler/icons outline brand-prisma (RunIcon: spans named prisma:*), drawn as TablerIcon does. */
export const TablerBrandPrismaIcon = ({ className }: P) => (
  <svg
    className={`stroke-[1.5] ${className ?? ""}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M4.186 16.202l3.615 5.313c.265 .39 .754 .57 1.215 .447l10.166 -2.718a1.086 1.086 0 0 0 .713 -1.511l-7.505 -15.483a.448 .448 0 0 0 -.787 -.033l-7.453 12.838a1.07 1.07 0 0 0 .037 1.147l-.001 0" />
    <path d="M8.5 22l3.5 -20" />
  </svg>
);

/** app/assets/icons/StatusIcon.tsx: a ring at 75% of the box. */
export const StatusIcon = ({ className }: P) => (
  <span className={`grid place-items-center ${className ?? ""}`}>
    <span className="size-[75%] rounded-full border-2 border-text-dimmed" />
  </span>
);

/** app/assets/icons/SparkleListIcon.tsx. */
export const SparkleListIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M17 11C17.4304 11 17.8126 11.2754 17.9487 11.6838L18.4743 13.2607C18.6734 13.858 19.142 14.3266 19.7393 14.5257L21.3162 15.0513C21.7246 15.1874 22 15.5696 22 16C22 16.4304 21.7246 16.8126 21.3162 16.9487L19.7393 17.4743C19.142 17.6734 18.6734 18.142 18.4743 18.7393L17.9487 20.3162C17.8126 20.7246 17.4304 21 17 21C16.5696 21 16.1874 20.7246 16.0513 20.3162L15.5257 18.7393C15.3266 18.142 14.858 17.6734 14.2607 17.4743L12.6838 16.9487C12.2754 16.8126 12 16.4304 12 16C12 15.5696 12.2754 15.1874 12.6838 15.0513L14.2607 14.5257C14.858 14.3266 15.3266 13.858 15.5257 13.2607L16.0513 11.6838C16.1874 11.2754 16.5696 11 17 11Z"
      fill="currentColor"
    />
    <rect x="2" y="6" width="20" height="2" rx="1" fill="currentColor" />
    <rect x="2" y="15" width="7" height="2" rx="1" fill="currentColor" />
  </svg>
);

/** @tabler/icons-react IconChartHistogram (outline, stroke 2). */
export const ChartHistogramIcon = ({ className }: P) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 3v18h18" />
    <path d="M20 18v3" />
    <path d="M16 16v5" />
    <path d="M12 13v8" />
    <path d="M8 16v5" />
    <path d="M3 11c6 0 5 -5 9 -5s3 5 9 5" />
  </svg>
);
// The Runs page header, filters and toolbar (runs._index/route.tsx, RunFilters.tsx).
export const QuestionMarkIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12.0232" r="9" stroke="currentColor" strokeWidth="2" />
    <path
      d="M9.27051 8.7533C9.7438 7.71876 10.788 7 12 7C13.6569 7 15 8.34315 15 10C15 11.6569 13.6569 13 12 13V14.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="17" r="1" fill="currentColor" />
  </svg>
);

/** assets/icons/ListCheckedIcon.tsx */
export const ListCheckedIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
    {[3, 8, 13].map((y) => (
      <path
        key={y}
        d={`M2.85001 ${y + 0.82759}L4.09139 ${y + 2.06897}L6.16035 ${y}`}
        stroke="currentColor"
        strokeWidth="1.65517"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ))}
    {[4, 9, 14].map((y) => (
      <path
        key={y}
        d={`M9 ${y}H15`}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ))}
  </svg>
);

/** assets/icons/ColumnsIcon.tsx */
export const ColumnsIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
    <line x1="9" y1="19" x2="9" y2="5" stroke="currentColor" strokeWidth="2" />
    <line x1="15" y1="19" x2="15" y2="5" stroke="currentColor" strokeWidth="2" />
  </svg>
);

/** assets/icons/ExitIcon.tsx */
export const ExitIcon = ({ className }: P) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <line x1="3.5" y1="8" x2="11.5" y2="8" stroke="currentColor" strokeLinecap="round" />
    <line x1="15.5" y1="1.5" x2="15.5" y2="14.5" stroke="currentColor" strokeLinecap="round" />
    <path
      d="M8.5 4.5L12 8L8.5 11.5"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** assets/icons/MachineIcon.tsx: MachineIconNoMachine, a run that hasn't started. */
export const MachineNoMachineIcon = ({ className }: P) => (
  <svg
    className={`text-[#D7D9DD] light:text-charcoal-500 ${className ?? ""}`}
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M16.1875 13C16.6362 13 17 13.3638 17 13.8125V16.1875C17 16.6362 16.6362 17 16.1875 17H6.18945C6.25882 16.9453 6.32663 16.8872 6.39062 16.8232L10.2139 13H16.1875Z"
      fill="currentColor"
      fillOpacity="0.4"
    />
    <path
      d="M4.84961 12H3.8125C3.36377 12 3 11.6362 3 11.1875V8.8125C3 8.36377 3.36377 8 3.8125 8H8.84961L4.84961 12ZM16.1875 8C16.6362 8 17 8.36377 17 8.8125V11.1875C17 11.6362 16.6362 12 16.1875 12H11.2139L15.2139 8H16.1875Z"
      fill="currentColor"
      fillOpacity="0.4"
    />
    <path
      d="M9.85059 7H3.8125C3.36377 7 3 6.63623 3 6.1875V3.8125C3 3.36377 3.36377 3 3.8125 3H13.8506L9.85059 7Z"
      fill="currentColor"
      fillOpacity="0.4"
    />
    <line
      x1="3"
      y1="16.9998"
      x2="17.0018"
      y2="2.99805"
      stroke="currentColor"
      strokeOpacity="0.4"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

/** components/GitHubLoginButton.tsx: OctoKitty (the GitHub mark). */
export const OctoKittyIcon = ({ className }: P) => (
  <svg
    className={className}
    viewBox="0 0 2350 2314.8"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M1175,0C525.8,0,0,525.8,0,1175c0,552.2,378.9,1010.5,890.1,1139.7c-5.9-14.7-8.8-35.3-8.8-55.8v-199.8H734.4 c-79.3,0-152.8-35.2-185.1-99.9c-38.2-70.5-44.1-179.2-141-246.8c-29.4-23.5-5.9-47,26.4-44.1c61.7,17.6,111.6,58.8,158.6,120.4 c47,61.7,67.6,76.4,155.7,76.4c41.1,0,105.7-2.9,164.5-11.8c32.3-82.3,88.1-155.7,155.7-190.9c-393.6-47-581.6-240.9-581.6-505.3 c0-114.6,49.9-223.3,132.2-317.3c-26.4-91.1-61.7-279.1,11.8-352.5c176.3,0,282,114.6,308.4,143.9c88.1-29.4,185.1-47,284.9-47 c102.8,0,196.8,17.6,284.9,47c26.4-29.4,132.2-143.9,308.4-143.9c70.5,70.5,38.2,261.4,8.8,352.5c82.3,91.1,129.3,202.7,129.3,317.3 c0,264.4-185.1,458.3-575.7,499.4c108.7,55.8,185.1,214.4,185.1,331.9V2256c0,8.8-2.9,17.6-2.9,26.4 C2021,2123.8,2350,1689.1,2350,1175C2350,525.8,1824.2,0,1175,0L1175,0z" />
  </svg>
);
