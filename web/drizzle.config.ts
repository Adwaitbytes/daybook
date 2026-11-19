import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/server/db/schema.ts",
  out: "./drizzle",
  schemaFilter: ["daybook"],
  dbCredentials: { url },
});
