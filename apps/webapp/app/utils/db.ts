export function isValidDatabaseUrl(url: string) {
  try {
    const databaseUrl = new URL(url);
    const schemaFromSearchParam = databaseUrl.searchParams.get("schema");

    if (schemaFromSearchParam === "") {
      console.error(
        "Invalid Database URL: The schema search param can't have an empty value. To use the `public` schema, either omit the schema param entirely or specify it in full: `?schema=public`"
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}
