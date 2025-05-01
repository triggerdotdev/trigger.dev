import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";

type ShortcutsContextType = {
  areShortcutsEnabled: boolean;
  disableShortcuts: () => void;
  enableShortcuts: () => void;
};

const ShortcutsContext = createContext<ShortcutsContextType | null>(null);

type ShortcutsProviderProps = {
  children: ReactNode;
};

export function ShortcutsProvider({ children }: ShortcutsProviderProps) {
  const [areShortcutsEnabled, setAreShortcutsEnabled] = useState(true);

  const disableShortcuts = useCallback(() => setAreShortcutsEnabled(false), []);
  const enableShortcuts = useCallback(() => setAreShortcutsEnabled(true), []);

  const value = useMemo(
    () => ({
      areShortcutsEnabled,
      disableShortcuts,
      enableShortcuts,
    }),
    [areShortcutsEnabled, disableShortcuts, enableShortcuts]
  );

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}

const throwIfNoProvider = () => {
  throw new Error("useShortcuts must be used within a ShortcutsProvider");
};

export const useShortcuts = () => {
  return useContext(ShortcutsContext) ?? throwIfNoProvider();
};
