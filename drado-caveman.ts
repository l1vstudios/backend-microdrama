export type CavemanConfig = {
  enabled: boolean;
  engineBin: string;
  skillPath: string;
};

export type PackedHistory = { format: 'JSON' | 'TOON'; content: string };

// Keep production prompts lossless. Do not use the engine's lossy prose compressor.
async function convert(bin: string, direction: 'encode' | 'decode', input: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const proc = Bun.spawn([bin, 'toon', direction], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const stop = () => proc.kill();
  const timer = setTimeout(stop, 2500);
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) stop();
    proc.stdin.write(input);
    proc.stdin.end();
    const [output, , code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    signal.throwIfAborted();
    if (code !== 0 || !output.trim()) throw new Error('Caveman conversion unavailable');
    return output;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (proc.exitCode === null) proc.kill();
  }
}

export async function packHistory(json: string, config: CavemanConfig | undefined, signal: AbortSignal): Promise<PackedHistory> {
  const original: PackedHistory = { format: 'JSON', content: json };
  if (!config?.enabled || json.length < 2000) return original;
  try {
    const packed = await convert(config.engineBin, 'encode', json, signal);
    const bytesBefore = Buffer.byteLength(json);
    const bytesAfter = Buffer.byteLength(packed);
    // Include the format explanation overhead; small requests stay in JSON.
    if (bytesAfter + 200 >= bytesBefore) return original;
    const decoded = await convert(config.engineBin, 'decode', packed, signal);
    const expected = JSON.parse(json) as { role: string; content: string }[];
    const actual: unknown = JSON.parse(decoded);
    if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((message, index) =>
      !message || message.role !== expected[index].role || message.content !== expected[index].content
    )) return original;
    // These are byte counts, not provider token usage or billing savings.
    console.info(`[drado:caveman] history bytes ${bytesBefore} -> ${bytesAfter}; lossless TOON`);
    return { format: 'TOON', content: packed };
  } catch {
    signal.throwIfAborted();
    console.warn('[drado:caveman] history kept as original JSON; local encoder unavailable');
    return original;
  }
}

export const cavemanInstructions = `CAVEMAN: Jawab ringkas dalam bahasa Indonesia, tanpa pembuka, basa-basi, rangkuman berulang, atau mengulang menu yang sudah selesai. Tampilkan hanya tahap/hasil yang diminta; jangan menerbitkan ulang seluruh master dan shot lama tanpa kebutuhan. Kelengkapan produksi lebih utama daripada gaya ringkas: semua prompt dalam code block tetap lengkap, siap generate, dan mengikuti skill drado-agent. Jangan memendekkan dialog, continuity, identitas, warna/material, voice, eyeline, negative constraints, ID, angka, atau durasi. Format tabel/heading untuk UI tetap wajib. Jangan mengubah output image/video generator.\n\n`;
