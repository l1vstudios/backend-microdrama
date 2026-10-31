import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDradoPrompt, createDradoRouter, hermesRunner } from './drado';
import type { Runner, Session } from './drado';
import { geminiScriptRunner } from './drado-engines';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'drado-storyboard-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('title-only storyboard persists through followup, retry and restart; validates mode', async () => {
  const directory = temporary();
  const received: Array<{ prompt: string; workflow?: string }> = [];
  let fail = false;
  const run: Runner = async (prompt, _signal, _cwd, context) => {
    received.push({ prompt, workflow: context?.workflow });
    if (fail) { fail = false; throw new Error('Fixture retry'); }
    return 'Storyboard fixture';
  };
  const service = createDradoRouter({ directory, run }); cleanups.push(service.close);
  const login = await service.router.request('/auth/login', { method: 'POST', body: JSON.stringify({ username: Bun.env.DRADO_ADMIN_USERNAME || 'admin', password: Bun.env.DRADO_ADMIN_PASSWORD || 'admin' }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = async (path: string, body?: unknown) => {
    const response = await service.router.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() as any };
  };
  const wait = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const { session } = await request(`/sessions/${id}`);
      if (session.status !== 'running') return session as Session;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Fixture timeout');
  };
  expect((await request('/sessions', { workflow: 'invalid' })).status).toBe(400);
  for (const storyboardEpisodes of [0, -1, 1.5, 101, '10', null]) expect((await request('/sessions', { workflow: 'storyboard', storyboardEpisodes })).status).toBe(400);
  expect((await request('/sessions', { workflow: 'default', storyboardEpisodes: 10 })).status).toBe(400);
  const { session } = await request('/sessions', { workflow: 'storyboard' });
  expect(session.storyboardEpisodes).toBe(1);
  const selected = await request('/sessions', { workflow: 'storyboard', storyboardEpisodes: 5 });
  expect(selected.session.storyboardEpisodes).toBe(5);
  const path = `/sessions/${session.id}/messages`;
  expect((await request(path, { content: 'Rahasia Pernikahan', workflow: 'storyboard', storyboardEpisodes: 10 })).status).toBe(202);
  let saved = await wait(session.id);
  expect(saved.title).toBe('Rahasia Pernikahan');
  expect(saved.messages[0].content).toBe('Rahasia Pernikahan');
  expect(saved.workflow).toBe('storyboard');
  expect(saved.storyboardEpisodes).toBe(10);
  fail = true;
  await request(path, { content: 'Revisi dialog S01' }); await wait(session.id);
  await request(path, { retry: true }); saved = await wait(session.id);
  expect(saved.messages).toHaveLength(4);
  for (const entry of received) {
    expect(entry.workflow).toBe('storyboard');
    expect(entry.prompt).toContain('MODE PROYEK: STORYBOARD + T2V');
    expect(entry.prompt).toContain('cukup judul');
    expect(entry.prompt).toContain('JUMLAH EPISODE PROYEK: 10');
    expect(entry.prompt).toContain('BRIDGING ANTAR-EPISODE');
    expect(entry.prompt).toContain('Episode berikutnya wajib menjawab cliffhanger sebelumnya');
    expect(entry.prompt).toContain('5-PANEL STORYBOARD REFERENCE');
    expect(entry.prompt).toContain('FIRST SHOT HARDCODE');
    expect(entry.prompt).toContain('SHOT_TYPE: ESTABLISHING');
    expect(entry.prompt).toContain('DURATION: 10s');
    expect(entry.prompt).toContain('Panel 1 [0.0–2.0s]');
    expect(entry.prompt).toContain('Panel 2 [2.0–4.0s]');
    expect(entry.prompt).toContain('Panel 3 [4.0–6.0s]');
    expect(entry.prompt).toContain('Panel 4 [6.0–8.0s]');
    expect(entry.prompt).toContain('Panel 5 [8.0–10.0s]');
    expect(entry.prompt).toContain('DIALOGUE CLOCK');
    expect(entry.prompt).toContain('speech window');
    expect(entry.prompt).toContain('PRE-OUTPUT GATE WAJIB');
    expect(entry.prompt).toContain('8 shot × 10 detik = 80 detik');
    expect(entry.prompt).toContain('## S01 — 00:00–00:10 | 10s | EP01_C01 — Establishing konflik');
    expect(entry.prompt).not.toContain('## S01 — 00:00–00:06');
    expect(entry.prompt).not.toContain('durasi hanya 4/6/8/10 detik');
    expect(entry.prompt).not.toContain('sesuaikan pembagian untuk clip lebih pendek');

    expect(entry.prompt).not.toContain('### NANO BANANA PRO — IMAGE KEYFRAME');
  }
  expect((await request(path, { content: 'Test', workflow: 'default' })).status).toBe(400);
  expect((await request(path, { content: 'Test', storyboardEpisodes: 3 })).status).toBe(400);
  service.close();
  const reopened = createDradoRouter({ directory, run }); cleanups.push(reopened.close);
  const response = await reopened.router.request(`/sessions/${session.id}`, { headers: { Cookie: cookie } });
  const restored = (await response.json() as any).session;
  expect(restored.workflow).toBe('storyboard');
  expect(restored.storyboardEpisodes).toBe(10);
});

test('existing projects retain their prompt contract', () => {
  const session: Session = { id: 'old', title: 'Old', status: 'idle', createdAt: '', updatedAt: '', messages: [] };
  const prompt = buildDradoPrompt(session);
  expect(prompt).toContain('### NANO BANANA PRO — IMAGE KEYFRAME');
  expect(prompt).not.toContain('MODE PROYEK: STORYBOARD');
});

test('Hermes receives the full reference and records it without passing a fake skill to CLI', async () => {
  const directory = temporary(); const bin = join(directory, 'hermes'); const skillPath = join(directory, 'SKILL.md');
  writeFileSync(skillPath, 'Fixture'); mkdirSync(join(directory, 'references'));
  writeFileSync(join(directory, 'references/storyboard-t2v-workflow.md'), 'FULL STORYBOARD FIXTURE');
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@"\n'); chmodSync(bin, 0o755);
  const run = hermesRunner(bin, 1000, { skillPath });
  const output = await run('TITLE FIXTURE', new AbortController().signal, directory, { workflow: 'storyboard' });
  if (typeof output === 'string') throw new Error('Missing skill metadata');
  expect(output.skills).toContain('drado-agent/storyboard-t2v');
  expect(output.content).toContain('--skills\ndrado-agent\n-z\n');
  expect(output.content).toContain('FULL STORYBOARD FIXTURE');
  expect(output.content).toContain('TITLE FIXTURE');
  rmSync(join(directory, 'references/storyboard-t2v-workflow.md'));
  await expect(run('Title', new AbortController().signal, directory, { workflow: 'storyboard' })).rejects.toThrow('Referensi storyboard Hermes belum ditemukan');
});

test('Gemini storyboard mode loads the same reference and reports it', async () => {
  const directory = temporary(); const skillPath = join(directory, 'SKILL.md');
  writeFileSync(skillPath, 'Fixture'); mkdirSync(join(directory, 'references'));
  writeFileSync(join(directory, 'references/storyboard-t2v-workflow.md'), 'GEMINI STORYBOARD FIXTURE');
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
    expect(String(options.body)).toContain('GEMINI STORYBOARD FIXTURE');
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Done' }] } }] });
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = original; });
  const runner = geminiScriptRunner({ apiKey: 'fixture', baseUrl: 'https://fixture.invalid', model: 'fixture', skillPath, timeoutMs: 1000 });
  const output = await runner('Title', new AbortController().signal, directory, { workflow: 'storyboard' });
  expect(typeof output !== 'string' && output.skills).toContain('drado-agent/storyboard-t2v');
});
