import {
  FormEncodedBodyFormat,
  FormEncodedBodyFormatEncoding,
} from "core/endpoint/types";
import { URLSearchParams } from "url";

function urlEncodeBody(format: FormEncodedBodyFormat, body: any): string {
  const parts = new URLSearchParams();
  const encoding = format.encoding;

  for (const name in encoding.e) {
    if (!Object.prototype.hasOwnProperty.call(encoding, name)) continue;

    const element = encoding[name];
    const value = body[name];

    if (value === undefined) {
      continue;
    }

    switch (element.style) {
      case "form": {
        if (Array.isArray(value)) {
          if (element.explode) {
            for (const item of value) {
              parts.append(name, item);
            }
          } else {
            parts.append(name, value.join(","));
          }
        } else if (typeof value === "object") {
          if (element.explode) {
            Object.entries(value).forEach(([key, value]) => {
              parts.append(`${key}`, `${value}`);
            });
          } else {
            throw new Error(`Not implemented: ${element.style} explode=false`);
          }
        } else {
          parts.append(name, `${value}`);
        }
        break;
      }
      case "spaceDelimited":
        delimit(" ", value, element, parts, name);
        break;
      case "pipeDelimited":
        delimit("|", value, element, parts, name);
        break;
      case "deepObject":
        if (Array.isArray(value)) {
          throw new Error(`Not implemented: ${element.style} array`);
        } else if (typeof value === "object") {
          if (element.explode) {
            Object.entries(value).forEach(([key, value]) => {
              parts.append(`${name}[${key}]`, `${value}`);
            });
          } else {
            throw new Error(`Not implemented: ${element.style} explode=false`);
          }
        } else {
          parts.append(name, `${value}`);
        }
        break;
    }
  }

  return parts.toString();
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
