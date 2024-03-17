import { useLocation, useNavigation, useResolvedPath } from "@remix-run/react";
import type { RelativeRoutingType } from "@remix-run/router";

//A lot of this logic is lifted from <NavLink> in react-router-dom, thanks again Remix team ❤️.
//https://github.com/remix-run/react-router/blob/a04ae6b90127ae583be08432c52b951e53f6a3c7/packages/react-router-dom/index.tsx#L1010

type Options = {
  /** Defines the relative path behavior for the link.
   *
   *  route - default, relative to the route hierarchy so .. will remove all URL segments of the current route pattern
   *
   *  path - relative to the path so .. will remove one URL segment
   */
  relative?: RelativeRoutingType;
  /** The end prop changes the matching logic for the active and pending states to only match to the "end" of the NavLinks's to path. If the URL is longer than to, it will no longer be considered active. */
  end?: boolean;
};

type Result = {
  isActive: boolean;
  isPending: boolean;
  isTransitioning: boolean;
};

/** Pass a relative link and you will get back whether it's the current page, about to be and whether the route is currently changing */
export function useLinkStatus(to: string, options?: Options): Result {
  const { relative, end = false } = options || {};

  const path = useResolvedPath(to, { relative: relative });
  const pathName = path.pathname.toLowerCase();

  //current location and pending location (if there is one)
  const location = useLocation();
  const locationPathname = location.pathname.toLowerCase();
  const navigation = useNavigation();
  const nextLocationPathname = navigation.location
    ? navigation.location.pathname.toLowerCase()
    : null;

  // If the `to` has a trailing slash, look at that exact spot.  Otherwise,
  // we're looking for a slash _after_ what's in `to`.  For example:
  //
  // <NavLink to="/users"> and <NavLink to="/users/">
  // both want to look for a / at index 6 to match URL `/users/matt`
  const endSlashPosition =
    pathName !== "/" && pathName.endsWith("/") ? pathName.length - 1 : pathName.length;

  const isActive =
    locationPathname === pathName ||
    (!end &&
      locationPathname.startsWith(pathName) &&
      locationPathname.charAt(endSlashPosition) === "/");

  const isPending =
    nextLocationPathname != null &&
    (nextLocationPathname === pathName ||
      (!end &&
        nextLocationPathname.startsWith(pathName) &&
        nextLocationPathname.charAt(pathName.length) === "/"));

  return {
    isActive,
    isPending,
    isTransitioning: navigation.state === "loading",
  };
}
