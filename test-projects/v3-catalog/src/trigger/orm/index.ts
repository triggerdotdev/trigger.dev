import "reflect-metadata";
import { DataSource } from "typeorm";
import { Entity, Column, PrimaryColumn } from "typeorm";

@Entity()
export class Photo {
  @PrimaryColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  description!: string;

  @Column()
  filename!: string;

  @Column()
  views!: number;

  @Column()
  isPublished!: boolean;
}

export const AppDataSource = new DataSource({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "postgres",
  database: "v3-catalog",
  entities: [Photo],
  synchronize: true,
  logging: false,
});
