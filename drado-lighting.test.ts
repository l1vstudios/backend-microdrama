import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDradoPrompt, createDradoRouter, hermesRunner } from './drado';
import { geminiScriptRunner } from './drado-engines';
import { lightingInstructions, visualStyleInstructions } from './drado-lighting';
import { listHermesSkills } from './drado-skills';
import type { Lighting } from './drado-lighting';
import type { Runner, Session } from './drado';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'drado-lighting-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function app(run: Runner = async () => 'Prompt selesai', directory = temporary()) {
  const service = createDradoRouter({ directory, run });
  cleanups.push(service.close);
  const login = await service.router.request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: Bun.env.DRADO_ADMIN_USERNAME || 'admin', password: Bun.env.DRADO_ADMIN_PASSWORD || 'admin' }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  async function request(path: string, body?: unknown, method = 'POST') {
    const response = await service.router.request(path, { method: body === undefined ? 'GET' : method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() as any };
  }
  async function wait(id: string) {
    for (let n = 0; n < 100; n++) {
      const result = await request(`/sessions/${id}`);
      if (result.session.status !== 'running') return result.session as Session;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Job did not finish');
  }
  return { service, request, wait, directory };
}

test('lighting persists across reload/restart, reaches followups and retry, and validates updates', async () => {
  const prompts: string[] = []; const contexts: unknown[] = [];
  let fail = false;
  const current = await app(async (prompt, _signal, _cwd, context) => {
    prompts.push(prompt); contexts.push(context);
    if (fail) { fail = false; throw new Error('Retry fixture'); }
    return 'Prompt lengkap';
  });
  expect((await current.request('/sessions', { lighting: 'unknown' })).status).toBe(400);
  const { session } = await current.request('/sessions', { lighting: 'drama' });
  await current.request(`/sessions/${session.id}/messages`, { content: 'Buat prompt image dan video' });
  await current.wait(session.id);
  expect(prompts[0]).toContain('LIGHTING PRESET PROYEK — DRAMA');
  expect(contexts[0]).toEqual({ lighting: 'drama' });
  expect((await current.request(`/sessions/${session.id}`, { lighting: 'unknown' }, 'PATCH')).status).toBe(400);
  expect((await current.request(`/sessions/${session.id}`, { lighting: 'horror' }, 'PATCH')).session.lighting).toBe('horror');
  fail = true;
  await current.request(`/sessions/${session.id}/messages`, { content: 'Revisi shot berikutnya' });
  expect((await current.wait(session.id)).status).toBe('error');
  await current.request(`/sessions/${session.id}/messages`, { retry: true });
  const retried = await current.wait(session.id);
  expect(retried.messages).toHaveLength(4);
  expect(prompts[2]).toContain('LIGHTING PRESET PROYEK — HORROR');
  expect(prompts[2]).not.toContain('LIGHTING PRESET PROYEK — DRAMA');
  expect(contexts[2]).toEqual({ lighting: 'horror' });
  current.service.close();
  const reopened = await app(undefined, current.directory);
  expect((await reopened.request(`/sessions/${session.id}`)).session.lighting).toBe('horror');
  const legacy = (await reopened.request('/sessions', {})).session;
  expect(legacy.lighting).toBe('auto');
  expect(lightingInstructions(undefined)).toBe('');
  expect(lightingInstructions('auto')).toBe('');
});

test('lighting cannot change during a running script', async () => {
  const current = await app(async (_prompt, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return 'late';
  });
  const { session } = await current.request('/sessions', { lighting: 'outdoor' });
  await current.request(`/sessions/${session.id}/messages`, { content: 'Buat shot' });
  expect((await current.request(`/sessions/${session.id}`, { lighting: 'horror' }, 'PATCH')).status).toBe(409);
  expect((await current.request(`/sessions/${session.id}`)).session.lighting).toBe('outdoor');
  await current.request(`/sessions/${session.id}/cancel`, {});
  await current.wait(session.id);
});

test('every selected preset requires concrete image/video lighting and keeps asset identity', () => {
  for (const lighting of ['drama', 'outdoor', 'horror', 'fantasy', 'anime'] as Lighting[]) {
    const prompt = buildDradoPrompt({ id: 'test', title: '', status: 'idle', createdAt: '', updatedAt: '', messages: [], lighting });
    expect(prompt).toContain(`LIGHTING PRESET PROYEK — ${lighting.toUpperCase()}`);
    expect(prompt).toContain('NATURAL FACIAL LIGHTING');
    expect(prompt).toContain('FACIAL LIGHT CONTINUITY');
    expect(prompt).toContain('Master karakter/face/outfit anchor tetap memakai cahaya netral');
    expect(prompt).toContain('revisi/regenerate image sebelum video');
  }
});

test('Hermes loads the selected supporting skills and reports actual preloads', async () => {
  const directory = temporary(); const bin = join(directory, 'hermes-fixture');
  const skillPath = join(directory, 'SKILL.md'); writeFileSync(skillPath, 'Drado fixture');
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$2"\n'); chmodSync(bin, 0o755);
  const runner = hermesRunner(bin, 1000, { skillPath });
  for (const lighting of ['auto', 'drama', 'outdoor', 'horror', 'fantasy', 'anime'] as Lighting[]) {
    const inventory = await listHermesSkills(skillPath, undefined, lighting);
    const expected = inventory.filter(skill => skill.status === 'active').map(skill => skill.name);
    const output = await runner('Prompt', new AbortController().signal, directory, { lighting });
    expect(typeof output).toBe('object');
    if (typeof output !== 'string') {
      expect(output.skills).toEqual(expected);
      expect(output.content).toBe(expected.join(','));
    }
    if (lighting !== 'drama') expect(expected).not.toContain('natural_window_light');
    if (lighting === 'anime' || lighting === 'fantasy') expect(expected).not.toContain('cinematic-lighting-techniques');
  }
});

test('Fantasy and Anime selections persist and affect character masters and subsequent video prompts', async () => {
  const received: { prompt: string; lighting?: Lighting }[] = [];
  const current = await app(async (prompt, _signal, _cwd, context) => {
    received.push({ prompt, lighting: context?.lighting });
    return 'Styled master and shot fixture';
  });
  for (const lighting of ['fantasy', 'anime'] as const) {
    const created = await current.request('/sessions', { lighting });
    expect(created.status).toBe(201);
    const id = created.session.id;
    await current.request(`/sessions/${id}/messages`, { content: 'Buat master karakter dan prompt image' });
    await current.wait(id);
    await current.request(`/sessions/${id}/messages`, { content: 'Lanjutkan prompt video' });
    await current.wait(id);
    expect((await current.request(`/sessions/${id}`)).session.lighting).toBe(lighting);
    const last = received.at(-1)!;
    expect(last.lighting).toBe(lighting);
    expect(last.prompt).toContain(`PROJECT VISUAL STYLE OVERRIDE — ${lighting.toUpperCase()}`);
    expect(last.prompt).toContain('Every CHARACTER MASTER, face anchor, outfit anchor');
    expect(last.prompt).toContain('STYLE CONTINUITY LOCK');
    expect(last.prompt).toContain('keep prior approved assets intact');
    const next = lighting === 'anime' ? 'fantasy' : 'anime';
    expect((await current.request(`/sessions/${id}`, { lighting: next }, 'PATCH')).session.lighting).toBe(next);
    const catalog = await current.request(`/skills?lighting=${lighting}`);
    expect(catalog.status).toBe(200);
    expect(catalog.skills.map((skill: { name: string }) => skill.name)).not.toContain('cinematic-lighting-techniques');
  }
});

test('Hermes receives illustrated style at system level without changing global configuration', async () => {
  const directory = temporary(); const bin = join(directory, 'hermes-style-fixture');
  const skillPath = join(directory, 'SKILL.md'); writeFileSync(skillPath, 'Drado fixture');
  writeFileSync(bin, '#!/bin/sh\nprintf "%s" "$HERMES_EPHEMERAL_SYSTEM_PROMPT"\n'); chmodSync(bin, 0o755);
  const original = Bun.env.HERMES_EPHEMERAL_SYSTEM_PROMPT;
  const runner = hermesRunner(bin, 1000, { skillPath });
  for (const lighting of ['fantasy', 'anime'] as const) {
    const output = await runner('Design characters', new AbortController().signal, directory, { lighting });
    expect(typeof output).toBe('object');
    if (typeof output !== 'string') {
      expect(output.content).toContain(`PROJECT VISUAL STYLE OVERRIDE — ${lighting.toUpperCase()}`);
      expect(output.content).toContain('VISUAL STYLE LOCK');
      expect(output.content).toContain('STYLE CONTINUITY LOCK');
      expect(output.skills).not.toContain('cinematic-lighting-techniques');
    }
  }
  expect(Bun.env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toBe(original);
});

test('Gemini receives the same selected rules and records loaded lighting sources', async () => {
  const directory = temporary(); const skillPath = join(directory, 'SKILL.md');
  writeFileSync(skillPath, 'DRADO CORE FIXTURE');
  let payload: any;
  const server = Bun.serve({ port: 0, fetch: async request => {
    payload = await request.json();
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Prompt Gemini' }] } }] });
  } });
  cleanups.push(() => server.stop(true));
  const runner = geminiScriptRunner({ apiKey: 'fixture', baseUrl: server.url.toString(), model: 'fixture', skillPath, timeoutMs: 2000 });
  for (const lighting of ['outdoor', 'fantasy', 'anime'] as const) {
    const prompt = lightingInstructions(lighting);
    const output = await runner(prompt, new AbortController().signal, directory, { lighting });
    expect(payload.contents[0].parts[0].text).toBe(prompt);
    expect(payload.systemInstruction.parts[0].text).toContain('DRADO CORE FIXTURE');
    expect(typeof output).toBe('object');
    if (typeof output !== 'string') {
      const expected = (await listHermesSkills(skillPath, undefined, lighting)).filter(skill => skill.status === 'active').map(skill => skill.name);
      expect(output.skills).toEqual(expected);
      if (expected.includes('cinematic-lighting-techniques')) expect(payload.systemInstruction.parts[0].text).toContain('Physical Integration Lighting Contract');
      expect(output.skills).not.toContain('natural_window_light');
      if (lighting !== 'outdoor') {
        expect(output.skills).not.toContain('cinematic-lighting-techniques');
        expect(payload.systemInstruction.parts[0].text.endsWith(visualStyleInstructions(lighting))).toBe(true);
      }
    }
  }
});
