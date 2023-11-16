export const getBasicProperties = (payload: { id: string | number }) => {
  return [{ label: "ID", text: String(payload.id) }];
};
