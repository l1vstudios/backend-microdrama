export function loadEnv(path = ".env") {
  const file = Bun.file(path);
  return file.exists().then(async (exists) => {
    if (!exists) return;
    const text = await file.text();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.includes("=") ? "=" : line.includes(":") ? ":" : "";
      if (!separator) continue;
      const index = line.indexOf(separator);
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && Bun.env[key] === undefined) Bun.env[key] = value;
    }
  });
}

export async function initEnv() {
  await loadEnv();
  await loadEnv("../morai/.env");
  if (Bun.env.HOME) await loadEnv(`${Bun.env.HOME}/.hermes/.env`);
}

export function envString(name: string, fallback = "") {
  return (Bun.env[name] || fallback).trim();
}

export function envNumber(name: string, fallback: number) {
  const value = Number(Bun.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
