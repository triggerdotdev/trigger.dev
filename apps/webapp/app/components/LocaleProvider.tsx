import type { ReactNode } from "react";
import { useContext } from "react";
import { createContext } from "react";

type LocaleContext = {
  locales: string[];
};

type LocaleContextProviderProps = {
  locales: string[];
  children: ReactNode;
};

const Context = createContext<LocaleContext | null>(null);

export const LocaleContextProvider = ({
  locales,
  children,
}: LocaleContextProviderProps) => {
  const value = { locales };

  return <Context.Provider value={value}>{children}</Context.Provider>;
};

const throwIfNoProvider = () => {
  throw new Error("Please wrap your application in a LocaleContextProvider.");
};

export const useLocales = () => {
  const { locales } = useContext(Context) ?? throwIfNoProvider();
  return locales;
};
