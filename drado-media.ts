import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { calculateCost, costTotals, pricingFor, responseUsage } from './drado-cost';
import type { MediaCost } from './drado-cost';
import { defaultEngines, generateHermesImage, hermesImageAvailable } from './drado-engines';
import type { Engine, Engines, HermesImageConfig } from './drado-engines';
type SessionSource = { title?: string; engines?: Engines; messages: { id: string; role: string }[] };
export type MediaConfig = { apiKey: string; baseUrl: string; imageModel: string; videoModel: string; hermesImage?: HermesImageConfig };
type Job = { id: string; sessionId: string; messageId: string; targetId: string; assetId?: string; kind: 'image' | 'video'; status: 'running' | 'completed' | 'failed'; model: string; engine?: Engine; aspectRatio: string; resolution?: '720p' | '1080p'; imageSize?: '1K' | '2K'; width?: number; height?: number; upscaled?: boolean; prompt: string; mimeType?: string; filename?: string; error?: string; createdAt: string; cost?: MediaCost; usageFinal?: boolean; providerReference?: string };
export function createMediaRouter(options: { directory: string; getSession: (id: string) => SessionSource | undefined; config?: MediaConfig }) {
  const directory = join(options.directory, 'generated'); mkdirSync(directory, { recursive: true });
  const db = new Database(join(options.directory, 'generated.sqlite'), { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)');
  db.run('CREATE INDEX IF NOT EXISTS media_session ON media(session_id)');
  db.run('CREATE TABLE IF NOT EXISTS media_costs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const read = (id: string): Job | undefined => { const row = db.query('SELECT data FROM media WHERE id = ?').get(id) as { data: string } | null; return row ? JSON.parse(row.data) : undefined; };
  const list = (id?: string): Job[] => (id ? db.query('SELECT data FROM media WHERE session_id = ? ORDER BY rowid DESC').all(id) : db.query('SELECT data FROM media').all()).map((row: any) => JSON.parse(row.data));
  const publicJob = ({ filename, prompt, usageFinal, ...job }: Job) => ({ ...job, cost: job.cost || calculateCost(job.kind), url: job.status === 'completed' ? `/api/drado/sessions/${job.sessionId}/media/${job.id}/content` : undefined });
  type LedgerJob = ReturnType<typeof publicJob> & { projectTitle: string };
  const record = (job: Job, initial = false) => {
    const entry: LedgerJob = { ...publicJob(job), projectTitle: options.getSession(job.sessionId)?.title || 'Proyek dihapus' };
    db.query(`INSERT OR ${initial ? 'IGNORE' : 'REPLACE'} INTO media_costs (id, data) VALUES (?, ?)`).run(job.id, JSON.stringify(entry));
  };
  const save = db.transaction((job: Job) => {
    job.cost = job.engine === 'hermes' ? { currency: 'USD', usdMicros: null, status: job.status === 'running' ? 'pending' : 'unavailable', note: 'Biaya image ChatGPT via Hermes tidak dilaporkan oleh plugin OAuth. Periksa penggunaan akun ChatGPT.' } : calculateCost(job.kind, job.cost?.pricing, job.cost?.usage, job.usageFinal, job.status === 'running');
    db.query('INSERT OR REPLACE INTO media (id, session_id, data) VALUES (?, ?, ?)').run(job.id, job.sessionId, JSON.stringify(job));
    record(job);
  });
  // Preserve usage/cost history even when its project and generated files are removed.
  for (const job of list()) record(job, true);
  const active = new Map<string, AbortController>(); let closed = false;
  const router = new Hono(); const config = options.config;
  for (const job of list()) if (job.status === 'running') { job.status = 'failed'; job.error = 'Backend dimulai ulang sebelum hasil tersimpan. Periksa provider sebelum generate ulang.'; save(job); }
  async function imageData(job: Job) {
    if (!job.filename || !job.mimeType) throw new Error('File referensi belum tersedia.');
    return { mimeType: job.mimeType, data: Buffer.from(await Bun.file(join(directory, job.filename)).arrayBuffer()).toString('base64') };
  }
  async function generate(job: Job, referenceIds: string[], anchorId?: string) {
    const controller = new AbortController(); active.set(job.id, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]);
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': config!.apiKey };
    const base = config!.baseUrl.replace(/\/+$/, '');
    const generationPrompt = `Output frame: ${job.aspectRatio}. This frame format takes precedence. Preserve all dialogue and production details.\n\n${job.prompt}`;
    async function request(url: string, body?: unknown) {
      const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal });
      const data: any = await response.json().catch(() => ({}));
      const usage = responseUsage(data, job.kind);
      if (!closed && usage) {
        job.cost = { ...(job.cost || calculateCost(job.kind)), usage };
        job.usageFinal = job.kind === 'image' || ['completed', 'failed', 'cancelled'].includes(data.status);
        if (typeof data.id === 'string') job.providerReference = data.id;
        save(job);
      }
      if (!response.ok) throw new Error(data?.error?.message || `Generator mengembalikan HTTP ${response.status}.`);
      return data;
    }
    try {
      let media: { data: string; mimeType: string; width?: number; height?: number; upscaled?: boolean } | undefined;
      if (job.kind === 'image' && job.engine === 'hermes') {
        const references = referenceIds.map(id => join(directory, read(id)!.filename!));
        const referenceLabels = referenceIds.map(id => read(id)!.assetId).filter(Boolean).join(', ');
        media = await generateHermesImage(config!.hermesImage!, { prompt: `${generationPrompt}\n\nAttached project reference images, in order: ${referenceLabels || 'none'}. Preserve exact identity, wardrobe, colors and materials.`, aspectRatio: job.aspectRatio, references, imageSize: job.imageSize }, signal);
      } else if (job.kind === 'image') {
        const parts: any[] = [{ text: generationPrompt }];
        for (const id of referenceIds) {
          const reference = read(id)!;
          parts.push({ text: `Project reference ${reference.assetId}. Preserve the reference identity, colors, materials and wardrobe.` }, { inlineData: await imageData(reference) });
        }
        const response = await request(`${base}/models/${encodeURIComponent(job.model)}:generateContent`, { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: job.aspectRatio, ...(job.imageSize ? { imageSize: job.imageSize } : {}) } } });
        const inline = response.candidates?.flatMap((c: any) => c.content?.parts || []).map((part: any) => part.inlineData || part.inline_data).find((part: any) => part?.data && (part.mimeType || part.mime_type || '').startsWith('image/'));
        if (inline) media = { data: inline.data, mimeType: inline.mimeType || inline.mime_type };
        else throw new Error(response.promptFeedback?.blockReason || 'Gemini tidak mengembalikan gambar. Periksa prompt dan batasan akun.');
      } else {
        const anchor = await imageData(read(anchorId!)!);
        let interaction = await request(`${base}/interactions`, {
          model: job.model,
          input: [{ type: 'image', data: anchor.data, mime_type: anchor.mimeType }, { type: 'text', text: generationPrompt }],
          response_format: { type: 'video', aspect_ratio: job.aspectRatio, resolution: job.resolution || '720p' },
          generation_config: { video_config: { task: 'image_to_video' } },
        });
        for (let count = 0; ['in_progress', 'running', 'pending'].includes(interaction.status) && count < 180; count++) {
          if (!interaction.id) throw new Error('Omni tidak mengembalikan ID proses.');
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new Error('Pemantauan generasi dihentikan.')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 5000);
            signal.addEventListener('abort', abort, { once: true });
          });
          interaction = await request(`${base}/interactions/${encodeURIComponent(interaction.id)}`);
        }
        if (interaction.error || ['failed', 'cancelled'].includes(interaction.status)) throw new Error(interaction.error?.message || 'Omni gagal membuat video.');
        // REST responses contain model output in steps; output_video is SDK-only.
        const output = (interaction.steps || []).filter((step: any) => step.type === 'model_output').flatMap((step: any) => step.content || []);
        const video = output.find((part: any) => part.type === 'video' && part.data);
        if (video) media = { data: video.data, mimeType: video.mime_type || 'video/mp4' };
        else throw new Error('Omni tidak mengembalikan file video. Periksa respons atau akses model pada akun Google.');
      }
      const ext = media!.mimeType === 'video/mp4' ? 'mp4' : media!.mimeType === 'image/jpeg' ? 'jpg' : media!.mimeType === 'image/webp' ? 'webp' : media!.mimeType === 'image/png' ? 'png' : null;
      if (!ext) throw new Error('Format hasil generator belum didukung.');
      job.filename = `${job.id}.${ext}`; job.mimeType = media!.mimeType;
      if (media!.width && media!.height) { job.width = media!.width; job.height = media!.height; job.upscaled = media!.upscaled; }
      await Bun.write(join(directory, job.filename), Buffer.from(media!.data, 'base64'));
      if (!closed) { job.status = 'completed'; save(job); }
    } catch (error) {
      if (!closed) { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Generasi gagal.'; save(job); }
    } finally { active.delete(job.id); }
  }
  router.use('*', async (c, next) => { if (!options.getSession(c.req.param('id')!)) return c.json({ ok: false, error: 'Proyek tidak ditemukan.' }, 404); await next(); });
  router.get('/', c => c.json({ ok: true, jobs: list(c.req.param('id')).map(publicJob) }));
  router.post('/', async c => {
    const sessionId = c.req.param('id')!; const body = await c.req.json().catch(() => null);
    if (!body || !options.getSession(sessionId)!.messages.some(m => m.id === body.messageId && m.role === 'assistant')) return c.json({ ok: false, error: 'Sumber prompt tidak valid.' }, 400);
    if (typeof body.targetId !== 'string' || !/^[a-zA-Z0-9_:.-]{1,180}$/.test(body.targetId) || !['image', 'video'].includes(body.kind)) return c.json({ ok: false, error: 'Target generasi tidak valid.' }, 400);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 35000) return c.json({ ok: false, error: 'Prompt wajib diisi, maksimal 35.000 karakter.' }, 400);
    if (body.aspectRatio !== undefined && !['9:16', '16:9', '1:1', '4:3', '3:4'].includes(body.aspectRatio)) return c.json({ ok: false, error: 'Rasio frame tidak didukung.' }, 400);
    if (body.kind === 'video' && body.resolution !== undefined && !['720p', '1080p'].includes(body.resolution)) return c.json({ ok: false, error: 'Pilih resolusi video 720p atau 1080p.' }, 400);
    if (body.kind === 'image' && body.imageSize !== undefined && !['1K', '2K', 'auto'].includes(body.imageSize)) return c.json({ ok: false, error: 'Resolusi gambar memakai HD (1K).' }, 400);
    // Normalize legacy Auto/2K requests too: all new image jobs use HD.
    const imageSize = body.kind === 'image' ? '1K' as const : undefined;
    const aspectRatio = body.aspectRatio || '9:16';
    const resolution = body.kind === 'video' ? body.resolution || '720p' : undefined;
    const existing = list(sessionId);
    if (existing.some(j => j.messageId === body.messageId && j.targetId === body.targetId && j.kind === body.kind && j.status === 'running')) return c.json({ ok: false, error: 'Generasi ini masih berjalan.' }, 409);
    if (active.size >= 2) return c.json({ ok: false, error: 'Dua generasi sedang berjalan. Tunggu proses selesai.' }, 429);
    const anchor = existing.find(j => j.messageId === body.messageId && j.targetId === body.targetId && j.kind === 'image' && j.status === 'completed' && (body.aspectRatio === undefined || j.aspectRatio === aspectRatio));
    if (body.kind === 'video' && !anchor) return c.json({ ok: false, error: `Generate gambar shot dengan rasio ${aspectRatio} terlebih dahulu sebagai start frame video.` }, 400);
    const required = body.kind === 'image' ? [...new Set<string>(prompt.match(/@(?:CHAR|LOC|PROP)_[A-Z0-9_]+\b/g) || [])].map(id => id.slice(1)) : [];
    const references = required.map(id => existing.find(j => j.assetId === id && j.kind === 'image' && j.status === 'completed'));
    const missing = required.filter((_, index) => !references[index]);
    if (missing.length) return c.json({ ok: false, error: `Generate master asset berikut terlebih dahulu: ${missing.join(', ')}.` }, 400);
    const engine = body.kind === 'video' ? 'gemini' : options.getSession(sessionId)!.engines?.image || defaultEngines.image;
    if (engine === 'hermes' ? !await hermesImageAvailable(config?.hermesImage) : !config?.apiKey) return c.json({ ok: false, error: engine === 'hermes' ? 'Plugin image ChatGPT atau Python Hermes belum tersedia di backend.' : 'Gemini API key belum tersedia di backend. Gunakan GOOGLE_API_KEY atau GEMINI_API_KEY.' }, 503);
    // Readiness may await disk access; recheck before accepting a paid generation.
    if (!options.getSession(sessionId)) return c.json({ ok: false, error: 'Proyek tidak ditemukan.' }, 404);
    if (!options.getSession(sessionId)!.messages.some(message => message.id === body.messageId && message.role === 'assistant')) return c.json({ ok: false, error: 'Pesan sumber sudah dihapus. Pilih prompt lain sebelum generate.' }, 409);
    if (engine !== (body.kind === 'video' ? 'gemini' : options.getSession(sessionId)!.engines?.image || defaultEngines.image)) return c.json({ ok: false, error: 'Engine berubah. Generate ulang dengan pilihan terbaru.' }, 409);
    if (active.size >= 2 || list(sessionId).some(j => j.messageId === body.messageId && j.targetId === body.targetId && j.kind === body.kind && j.status === 'running')) return c.json({ ok: false, error: 'Generasi lain sedang berjalan. Tunggu proses selesai.' }, 409);
    const assetId = typeof body.assetId === 'string' && /^(?:CHAR|LOC|PROP)_[A-Z0-9_]+$/.test(body.assetId) ? body.assetId : undefined;
    if (body.kind === 'video' && !['9:16', '16:9'].includes(anchor!.aspectRatio)) return c.json({ ok: false, error: 'Keyframe video harus berformat 9:16 atau 16:9.' }, 400);
    // For face/outfit anchors, include the already generated master identity if available.
    const identity = assetId && !body.targetId.endsWith(':0') ? existing.find(j => j.assetId === assetId && j.kind === 'image' && j.status === 'completed') : undefined;
    const ids = [...new Set([...references.filter(Boolean).map(j => j!.id), ...(identity ? [identity.id] : [])])];
    if (ids.some(id => !read(id))) return c.json({ ok: false, error: 'Master referensi sudah dihapus. Generate master terlebih dahulu.' }, 409);
    if (engine === 'hermes' && ids.length > 16) return c.json({ ok: false, error: 'Image ChatGPT via Hermes mendukung maksimal 16 referensi.' }, 400);
    const model = engine === 'hermes' ? config!.hermesImage!.model : body.kind === 'image' ? config!.imageModel : config!.videoModel;
    const cost = calculateCost(body.kind, engine === 'gemini' ? pricingFor(model, body.kind, config!.baseUrl) : undefined, undefined, false, true);
    const job: Job = { id: crypto.randomUUID(), sessionId, messageId: body.messageId, targetId: body.targetId, assetId, kind: body.kind, status: 'running', model, engine, aspectRatio: body.kind === 'video' ? anchor!.aspectRatio : aspectRatio, resolution, imageSize, prompt, createdAt: new Date().toISOString(), cost };
    save(job); void generate(job, ids, anchor?.id); return c.json({ ok: true, job: publicJob(job) }, 202);
  });
  router.get('/:mediaId/content', async c => {
    const job = read(c.req.param('mediaId'));
    if (!job || job.sessionId !== c.req.param('id') || job.status !== 'completed' || !job.filename) return c.json({ ok: false, error: 'File hasil tidak ditemukan.' }, 404);
    const file = Bun.file(join(directory, job.filename)); if (!await file.exists()) return c.json({ ok: false, error: 'File hasil tidak ada di backend.' }, 404);
    const headers: Record<string, string> = { 'Content-Type': job.mimeType!, 'Accept-Ranges': 'bytes' };
    if (c.req.query('download') === '1') headers['Content-Disposition'] = `attachment; filename="${job.filename}"`;
    const range = c.req.header('range')?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]); const end = Math.min(range[2] ? Number(range[2]) : file.size - 1, file.size - 1);
      if (start > end || start >= file.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
      return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Content-Length': String(end - start + 1) } });
    }
    return new Response(file, { headers });
  });
  const usage = () => {
    const jobs = (db.query('SELECT data FROM media_costs').all() as { data: string }[]).map(row => JSON.parse(row.data) as LedgerJob).filter(job => job.engine !== 'hermes');
    const counts = (kind: Job['kind']) => {
      const matches = jobs.filter(job => job.kind === kind);
      return { total: matches.length, completed: matches.filter(job => job.status === 'completed').length, failed: matches.filter(job => job.status === 'failed').length, running: matches.filter(job => job.status === 'running').length, cost: costTotals(matches) };
    };
    return { image: counts('image'), video: counts('video'), cost: costTotals(jobs), jobs: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(job => ({ ...job, url: options.getSession(job.sessionId) && read(job.id)?.status === 'completed' ? job.url : undefined })) };
  };
  return { router, usage, busy: (id: string) => list(id).some(j => j.status === 'running'), removeMessage: (sessionId: string, messageId: string) => { for (const job of list(sessionId)) if (job.messageId === messageId) db.query('DELETE FROM media WHERE id = ?').run(job.id); }, removeSession: (id: string) => db.query('DELETE FROM media WHERE session_id = ?').run(id), close: () => { if (closed) return; closed = true; for (const controller of active.values()) controller.abort(); db.close(); } };
}
