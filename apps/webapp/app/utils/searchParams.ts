export function objectToSearchParams(
  obj:
    | undefined
    | Record<string, string | string[] | number | number[] | boolean | boolean[] | undefined>
): URLSearchParams | undefined {
  if (!obj) return undefined;

  const searchParams = new URLSearchParams();
  //for each item add to the search params, skip undefined and join arrays with commas
  Object.entries(obj).forEach(([key, value]) => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      searchParams.append(key, value.join(","));
    } else {
      searchParams.append(key, value.toString());
    }
  });

  return searchParams;
}
