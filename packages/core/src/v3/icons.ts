import { SeverityNumber } from "@opentelemetry/api-logs";

export function iconStringForSeverity(severityNumber: SeverityNumber) {
  switch (severityNumber) {
    case SeverityNumber.UNSPECIFIED:
      return undefined;
    case SeverityNumber.TRACE:
    case SeverityNumber.TRACE2:
    case SeverityNumber.TRACE3:
    case SeverityNumber.TRACE4:
      return "trace";
    case SeverityNumber.DEBUG:
    case SeverityNumber.DEBUG2:
    case SeverityNumber.DEBUG3:
    case SeverityNumber.DEBUG4:
      return "debug";
    case SeverityNumber.INFO:
    case SeverityNumber.INFO2:
    case SeverityNumber.INFO3:
    case SeverityNumber.INFO4:
      return "info";
    case SeverityNumber.WARN:
    case SeverityNumber.WARN2:
    case SeverityNumber.WARN3:
    case SeverityNumber.WARN4:
      return "warn";
    case SeverityNumber.ERROR:
    case SeverityNumber.ERROR2:
    case SeverityNumber.ERROR3:
    case SeverityNumber.ERROR4:
      return "error";
    case SeverityNumber.FATAL:
    case SeverityNumber.FATAL2:
    case SeverityNumber.FATAL3:
    case SeverityNumber.FATAL4:
      return "fatal";
  }
}
