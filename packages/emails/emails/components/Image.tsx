import { Img } from "@react-email/components";
import * as React from "react";
import { getGlobalBasePath } from "./BasePath";

type ImageProps = Omit<Parameters<typeof Img>[0], "src"> & {
  path: string;
};

export function Image({ path, ...props }: ImageProps) {
  const basePath = getGlobalBasePath();

  return <Img src={`${basePath}${path}`} {...props} />;
}
