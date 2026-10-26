// ClickHouse DateTime / DateTime64 strings ("YYYY-MM-DD HH:MM:SS[.fff]") are UTC.
export function parseClickhouseDateTime(value: string): Date {
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
}
