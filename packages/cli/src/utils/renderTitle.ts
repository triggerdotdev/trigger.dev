import gradient from "gradient-string";
import { TITLE_TEXT } from "../consts";
import { getUserPackageManager } from "./getUserPkgManager";

// colors brought in from vscode poimandres theme
const poimandresTheme = {
  blue: "#add7ff",
  cyan: "#89ddff",
  green: "#5de4c7",
  magenta: "#fae4fc",
  red: "#d0679d",
  yellow: "#fffac2",
};

export const renderTitle = async (projectDirectory: string) => {
  const triggerGradient = gradient(Object.values(poimandresTheme));

  // resolves weird behavior where the ascii is offset
  const pkgManager = await getUserPackageManager(projectDirectory);
  if (pkgManager === "yarn" || pkgManager === "pnpm") {
    console.log("");
  }
  console.log(triggerGradient.multiline(TITLE_TEXT));
};
