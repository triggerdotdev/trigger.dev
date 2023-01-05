import React from "react";

type BasePathContext = { basePath: string };

const Context = React.createContext<BasePathContext>({
  basePath: "http://localhost:3000",
});

export function BasePath({
  basePath,
  children,
}: {
  basePath: string;
  children: React.ReactNode;
}) {
  return <Context.Provider value={{ basePath }}>{children}</Context.Provider>;
}

export function useBasePath() {
  return React.useContext(Context).basePath;
}
