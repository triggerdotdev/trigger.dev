import { TEMPLATE_ORGANIZATION } from "../consts";

export function createTemplateRef(templateName: string): string {
  return `github:${TEMPLATE_ORGANIZATION}/${templateName}`;
}
