"use client";

import React, { createContext, useContext } from "react";

type AuthContextState = {
  accessToken: string;
  baseURL: string;
};

const AuthContext = createContext<AuthContextState | undefined>(undefined);

export function AuthProvider({
  accessToken,
  baseURL,
  children,
}: AuthContextState & { children: React.ReactNode }) {
  return <AuthContext.Provider value={{ accessToken, baseURL }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within a AuthProvider");
  }
  return context;
}
