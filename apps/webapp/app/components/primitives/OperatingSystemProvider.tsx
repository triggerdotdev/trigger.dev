import type { ReactNode } from "react";
import { useContext } from "react";
import { createContext } from "react";

export type OperatingSystemPlatform = "mac" | "windows";

type OperatingSystemContext = {
  platform: OperatingSystemPlatform;
};

type OperatingSystemContextProviderProps = {
  platform: OperatingSystemPlatform;
  children: ReactNode;
};

const Context = createContext<OperatingSystemContext | null>(null);

export const OperatingSystemContextProvider = ({
  platform,
  children,
}: OperatingSystemContextProviderProps) => {
  return <Context.Provider value={{ platform }}>{children}</Context.Provider>;
};

const throwIfNoProvider = () => {
  throw new Error("Please wrap your application in an OperatingSystemContextProvider.");
};

export const useOperatingSystem = () => {
  const { platform } = useContext(Context) ?? throwIfNoProvider();
  return { platform };
};
