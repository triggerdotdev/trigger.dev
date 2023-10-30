export async function asyncFilter<T>(
  items: T[],
  filter: (item: T) => Promise<boolean>
): Promise<T[]> {
  const results = await Promise.all(items.map(filter));
  return items.filter((_, index) => results[index]);
}
