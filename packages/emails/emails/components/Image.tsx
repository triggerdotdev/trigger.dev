import { Img } from "@react-email/img";
import * as React from "react";
import { useBasePath } from "./BasePath";

type ImageProps = Omit<Parameters<typeof Img>[0], "src"> & {
  path: string;
};

export function Image({ path, ...props }: ImageProps) {
  const basePath = useBasePath();
  return <Img src={`${basePath}${path}`} {...props} />;
}
