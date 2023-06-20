import { useEffect, useState } from "react";

export type Modifier = "alt" | "ctrl" | "meta" | "shift";

export type Shortcut = {
  key: string;
  modifiers?: Modifier[];
};

export type ShortcutDefinition =
  | {
      windows: Shortcut;
      mac: Shortcut;
    }
  | {
      all: Shortcut;
    };
