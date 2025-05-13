import type { ColumnType } from "kysely";
export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type Post = {
  id: Generated<number>;
  title: string;
  content: string;
  authorId: number;
};
export type User = {
  id: Generated<number>;
  name: string;
};
export type DB = {
  Post: Post;
  User: User;
};
