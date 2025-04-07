import { createContext, useContext, useState, type ReactNode } from "react";

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

  const disableShortcuts = () => setAreShortcutsEnabled(false);
  const enableShortcuts = () => setAreShortcutsEnabled(true);

  return (
    <ShortcutsContext.Provider
      value={{
        areShortcutsEnabled,
        disableShortcuts,
        enableShortcuts,
      }}
    >
      {children}
    </ShortcutsContext.Provider>
  );
}

const throwIfNoProvider = () => {
  throw new Error("useShortcuts must be used within a ShortcutsProvider");
};

export const useShortcuts = () => {
  return useContext(ShortcutsContext) ?? throwIfNoProvider();
};
