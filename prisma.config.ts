import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  experimental: {
    externalTables: true,
  },
  tables: {
    // Litestream owns these tables. Prisma must never diff, recreate, or drop
    // them during startup schema synchronization.
    external: ["_litestream_seq", "_litestream_lock"],
  },
});
