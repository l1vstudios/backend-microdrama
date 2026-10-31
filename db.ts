import postgres from "postgres";
import { envString, initEnv } from "./env";

await initEnv();

const databaseUrl = envString("DATABASE_URL");
const databaseName = envString("PGDATABASE", "microdrama_mora");
const host = envString("PGHOST", "/tmp");
const username = envString("PGUSER", Bun.env.USER || "postgres");
const password = envString("PGPASSWORD");
const port = Number(envString("PGPORT", "5432"));

export const sql = databaseUrl
  ? postgres(databaseUrl, { max: 10 })
  : postgres({
      database: databaseName,
      host,
      username,
      password: password || undefined,
      port: Number.isFinite(port) ? port : 5432,
      max: 10,
    });

export async function closeDb() {
  await sql.end({ timeout: 5 });
}
