type QueryVariables = {
  after: string;
  before: string;
  first: number;
  includeArchived: boolean;
  last: number;
  orderBy: string;
};

type Nullable<T> = Partial<{
  [K in keyof T]: T[K] | null;
}>;

export const queryProperties = (query: Nullable<QueryVariables>) => {
  return [
    ...(query.after ? [{ label: "After", text: query.after }] : []),
    ...(query.before ? [{ label: "Before", text: query.before }] : []),
    ...(query.first ? [{ label: "First", text: String(query.first) }] : []),
    ...(query.last ? [{ label: "Last", text: String(query.last) }] : []),
    ...(query.orderBy ? [{ label: "Order by", text: query.orderBy }] : []),
    ...(query.includeArchived
      ? [{ label: "Include archived", text: String(query.includeArchived) }]
      : []),
  ];
};
