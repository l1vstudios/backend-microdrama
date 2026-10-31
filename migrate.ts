import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { closeDb, sql } from "./db";

async function ensureMigrationsTable() {
  await sql`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `;
}

async function main() {
  await ensureMigrationsTable();
  const dir = join(import.meta.dir, "migrations");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const applied = await sql`select id from schema_migrations where id = ${file}`;
    if (applied.length) {
      console.log(`skip ${file}`);
      continue;
    }

    const migrationSql = await Bun.file(join(dir, file)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(migrationSql);
      await tx`insert into schema_migrations (id) values (${file})`;
    });
    console.log(`applied ${file}`);
  }
}

try {
  await main();
} finally {
  await closeDb();
}
