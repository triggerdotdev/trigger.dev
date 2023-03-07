import {
  FormEncodedBodyFormat,
  FormEncodedBodyFormatEncoding,
} from "core/endpoint/types";
import { URLSearchParams } from "url";
import qs from "qs";

export function urlEncodeBody(
  format: FormEncodedBodyFormat,
  body: any
): string {
  //todo only supports deep object right now
  return qs.stringify(body);
}

function delimit(
  delimitter: string,
  value: any,
  element: FormEncodedBodyFormatEncoding,
  parts: URLSearchParams,
  name: string
) {
  if (Array.isArray(value)) {
    if (element.explode) {
      for (const item of value) {
        parts.append(name, item);
      }
    } else {
      parts.append(name, value.join(delimitter));
    }
  } else {
    parts.append(name, `${value}`);
  }
}
