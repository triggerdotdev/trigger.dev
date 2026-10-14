import { warmSharedPostgres } from "../src/sharedPostgres";

warmSharedPostgres().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
