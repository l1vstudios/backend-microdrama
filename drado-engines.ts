import { dirname, join } from 'node:path';
import type { Runner } from './drado';
import { lightingSkillDefinitions } from './drado-skills';
import { visualStyleInstructions } from './drado-lighting';
import { loadStoryboardReference } from './drado-storyboard';

export type Engine = 'hermes' | 'gemini';
export type Engines = { script: Engine; image: Engine };
export const defaultEngines: Engines = { script: 'hermes', image: 'gemini' };
export const validEngines = (value: unknown): value is Engines => Boolean(value && typeof value === 'object' && ['hermes', 'gemini'].includes((value as Engines).script) && ['hermes', 'gemini'].includes((value as Engines).image));

export function geminiScriptRunner(config: { apiKey: string; baseUrl: string; model: string; skillPath: string; timeoutMs: number; caveman?: { enabled: boolean; skillPath: string } }): Runner {
  return async (prompt, signal, _cwd, context) => {
    if (!config.apiKey) throw new Error('Gemini API key belum tersedia di backend.');
    const skill = Bun.file(config.skillPath);
    if (!await skill.exists()) throw new Error('Skill drado-agent belum ditemukan.');
    const sources = [await skill.text()];
    const skills = ['drado-agent'];
    const reference = Bun.file(join(dirname(config.skillPath), 'references/storyboard-t2v-workflow.md'));
    if (context?.workflow === 'storyboard') { sources.push(await loadStoryboardReference(config.skillPath)); skills.push('drado-agent/storyboard-t2v'); }
    else if (await reference.exists()) sources.push(`REFERENSI INTERNAL STORYBOARD/T2V:\n${await reference.text()}`);
    if (config.caveman?.enabled && await Bun.file(config.caveman.skillPath).exists()) {
      sources.push(await Bun.file(config.caveman.skillPath).text()); skills.push('caveman');
    }
    for (const supporting of lightingSkillDefinitions(context?.lighting)) {
      const file = Bun.file(supporting.path);
      if (await file.exists()) { sources.push(await file.text()); skills.push(supporting.name); }
    }
    const style = visualStyleInstructions(context?.lighting);
    if (style) sources.push(style);
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(config.model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      body: JSON.stringify({ systemInstruction: { parts: [{ text: `Ikuti instruksi produksi berikut. Buat teks/prompt saja, tanpa mengklaim menjalankan tool Hermes atau membuat media.\n\n${sources.join('\n\n')}` }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    });
    const data: any = await response.json().catch(() => null);
    if (!response.ok) { console.error('[drado:gemini] HTTP', response.status); throw new Error(`Gemini script gagal (HTTP ${response.status}). Periksa API key, model, kuota, atau billing Google.`); }
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw new Error(`Gemini menghentikan jawaban: ${candidate.finishReason}.`);
    if (candidate?.finishReason === 'MAX_TOKENS') throw new Error('Output Gemini terpotong oleh batas token. Coba minta produksi dalam bagian lebih kecil.');
    const content = candidate?.content?.parts?.filter((part: any) => !part.thought && typeof part.text === 'string').map((part: any) => part.text).join('\n').trim();
    if (!content) throw new Error('Gemini tidak mengembalikan teks. Periksa prompt dan batasan akun.');
    return { content, skills };
  };
}

export type HermesImageConfig = { python: string; root: string; model: string };
export async function resolveHermesPython(bin: string, root: string) {
  const launcher = await Bun.file(Bun.which(bin) || bin).slice(0, 8192).text().catch(() => '');
  const exec = launcher.match(/^exec\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/m);
  const shebang = launcher.match(/^#!([^\s]+python[^\s]*)/);
  const candidate = exec?.[1] || exec?.[2] || exec?.[3] || shebang?.[1];
  return candidate && /python[\d.]*$/.test(candidate) ? candidate : join(root, '.venv/bin/python');
}
export const hermesImageAvailable = async (config?: HermesImageConfig) => Boolean(config && ['gpt-image-2-low', 'gpt-image-2-medium', 'gpt-image-2-high'].includes(config.model) && Bun.which(config.python) && await Bun.file(join(config.root, 'plugins/image_gen/openai-codex/__init__.py')).exists());
export async function generateHermesImage(config: HermesImageConfig, input: { prompt: string; aspectRatio: string; references: string[]; imageSize?: '1K' | '2K' }, signal: AbortSignal) {
  const proc = Bun.spawn([config.python, join(import.meta.dir, 'drado-hermes-image.py')], {
    cwd: config.root, env: { ...Bun.env, PYTHONPATH: config.root, OPENAI_IMAGE_MODEL: config.model },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const stop = () => proc.kill();
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) { stop(); signal.throwIfAborted(); }
    proc.stdin.write(JSON.stringify(input)); proc.stdin.end();
    const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    signal.throwIfAborted();
    let result: any;
    try { result = JSON.parse(stdout); } catch { throw new Error('Bridge image Hermes gagal. Periksa instalasi Hermes dan dependensi Python.'); }
    if (code !== 0 || !result.ok) {
      console.error('[drado:hermes-image]', { code: typeof result.error === 'string' && /^[a-z_]{1,50}$/.test(result.error) ? result.error : 'bridge_error', status: Number.isInteger(result.status) ? result.status : undefined, module: typeof result.module === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(result.module) ? result.module : undefined });
      if (result.error === 'auth_required') throw new Error('Login ChatGPT di Hermes terlebih dahulu: hermes auth add openai-codex.');
      if (result.error === 'missing_dependency' || result.error === 'missing_dependency_error') {
        const module = typeof result.module === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(result.module) ? ` (${result.module})` : '';
        throw new Error(`Dependensi Python Hermes belum termuat${module}. Periksa runtime Hermes dan DRADO_HERMES_PYTHON di backend.`);
      }
      if (result.error === 'import_error') throw new Error('Plugin image Hermes gagal diimpor. Periksa kompatibilitas plugin dan environment Python Hermes.');
      if (result.status === 401) throw new Error('Sesi ChatGPT Hermes ditolak (HTTP 401). Login ulang: hermes auth add openai-codex.');
      if (result.status === 403) throw new Error('Akun ChatGPT menolak akses image Hermes (HTTP 403). Periksa izin dan akses image akun tersebut.');
      if (result.status === 429) throw new Error('Image ChatGPT dibatasi provider (HTTP 429). Periksa batas pemakaian akun sebelum mencoba lagi.');
      if (result.status === 404) throw new Error('Endpoint image ChatGPT via plugin Hermes tidak tersedia (HTTP 404). Periksa kompatibilitas plugin dan akses akun.');
      if (Number.isInteger(result.status) && result.status >= 400 && result.status <= 599) throw new Error(`Provider image ChatGPT menolak request (HTTP ${result.status}). Periksa log Hermes dan dukungan ukuran/model pada plugin.`);
      if (result.error === 'io_error') throw new Error('Hermes menerima hasil image tetapi gagal menyimpan file. Periksa direktori cache dan izin penyimpanan Hermes.');
      if (result.error === 'empty_response') throw new Error('Provider ChatGPT tidak mengembalikan data gambar ke Hermes.');
      if (result.error === 'invalid_image_input') throw new Error('Referensi image ditolak plugin Hermes. Periksa file master, format gambar, dan batas ukurannya.');
      throw new Error('Image ChatGPT via Hermes gagal. Periksa login ChatGPT, kuota, dan plugin openai-codex Hermes.');
    }
    if (typeof result.data !== 'string' || result.mimeType !== 'image/png') throw new Error('Hermes tidak mengembalikan gambar PNG.');
    return { data: result.data, mimeType: result.mimeType as string, width: Number.isInteger(result.width) ? result.width as number : undefined, height: Number.isInteger(result.height) ? result.height as number : undefined, upscaled: result.upscaled === true };
  } finally { signal.removeEventListener('abort', stop); }
}
