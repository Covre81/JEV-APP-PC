import { defineConfig } from 'drizzle-kit';

// `npm run db:generate` turns changes in the schema into a new SQL migration.
// Migrations are applied by jev-router itself on boot (src/telemetry/db.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/telemetry/schema.ts',
  out: './drizzle',
});
