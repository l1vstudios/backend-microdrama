import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDradoRouter, buildDradoPrompt } from './drado';

const resources: Array<{ close: () => void; directory: string }> = [];
afterEach(() => { for (const item of resources.splice(0)) { item.close(); rmSync(item.directory, { recursive: true, force: true }); } });
function setup(run: (prompt: string, signal: AbortSignal, cwd: string) => Promise<string> = async () => '## Drado\n\n```text\nNANO BANANA PRO — IMAGE\n```') {
  const directory = mkdtempSync(join(tmpdir(), 'morai-drado-test-'));
  const service = createDradoRouter({ directory, run });
  resources.push({ close: service.close, directory });
  const request = async (path: string, body?: any, method = 'POST') => {
    const response = await service.router.request(path, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  const create = async () => (await request('/sessions', {})).data.session;
  const wait = async (id: string) => {
    for (let n = 0; n < 100; n++) {
      const { data } = await request(`/sessions/${id}`);
      if (data.session.status !== 'running') return data.session;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Job did not finish');
  };
  return { directory, service, request, create, wait };
}
describe('Drado conversations', () => {
  test('persists complete Markdown and passes full cast/continuity history', async () => {
    const prompts: string[] = [];
    const app = setup(async prompt => { prompts.push(prompt); return '## S01\n```text\n@CHAR_RANIA_01\nFull prompt\n```'; });
    const session = await app.create();
    expect((await app.request(`/sessions/${session.id}/messages`, { content: 'Ide pertama' })).status).toBe(202);
    let saved = await app.wait(session.id);
    expect(saved.messages[1].content).toContain('```text');
    await app.request(`/sessions/${session.id}/messages`, { content: 'Custom Rania berhijab krem' });
    saved = await app.wait(session.id);
    expect(saved.messages).toHaveLength(4);
    expect(prompts[1]).toContain('Ide pertama');
    expect(prompts[1]).toContain('@CHAR_RANIA_01');
    expect(prompts[1]).toContain('Custom Rania berhijab krem');
    expect(prompts[1]).toContain('PENDING VISUAL CHECK');
  });
  test('rejects invalid input without adding a message', async () => {
    const app = setup(); const session = await app.create();
    for (const content of ['', 'a'.repeat(12001)]) expect((await app.request(`/sessions/${session.id}/messages`, { content })).status).toBe(400);
    expect((await app.request(`/sessions/${session.id}`)).data.session.messages).toHaveLength(0);
    expect((await app.request('/sessions/not-real')).status).toBe(404);
  });
  test('prevents duplicate jobs and cancellation discards late output', async () => {
    const app = setup(async (_prompt, signal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return 'late output'; });
    const s = await app.create();
    await app.request(`/sessions/${s.id}/messages`, { content: 'Buat drama' });
    expect((await app.request(`/sessions/${s.id}/messages`, { content: 'duplicate' })).status).toBe(409);
    await app.request(`/sessions/${s.id}/cancel`, {});
    const saved = await app.wait(s.id);
    expect(saved.status).toBe('error'); expect(saved.messages).toHaveLength(1);
    expect(saved.error).toContain('dihentikan');
  });
  test('retry keeps the same user message and recovers from runner failure', async () => {
    let attempts = 0;
    const app = setup(async () => { if (++attempts === 1) throw new Error('Provider unavailable'); return 'Selesai'; });
    const s = await app.create();
    await app.request(`/sessions/${s.id}/messages`, { content: 'Buat karakter' }); await app.wait(s.id);
    expect((await app.request(`/sessions/${s.id}/messages`, { retry: true })).status).toBe(202);
    const saved = await app.wait(s.id);
    expect(saved.messages).toHaveLength(2); expect(saved.status).toBe('idle'); expect(saved.error).toBeUndefined();
    expect((await app.request(`/sessions/${s.id}/messages`, { retry: true })).status).toBe(400);
  });
  test('rename and list survive reopening storage', async () => {
    const app = setup(); const s = await app.create();
    await app.request(`/sessions/${s.id}`, { title: 'Rania di hotel' }, 'PATCH');
    app.service.close(); resources[0].close = () => {};
    const reopened = createDradoRouter({ directory: app.directory, run: async () => '' }); resources[0].close = reopened.close;
    const data = await (await reopened.router.request('/sessions')).json() as any;
    expect(data.sessions[0].title).toBe('Rania di hotel');
    expect(data.sessions[0].messages).toBeUndefined();
  });
  test('context uses JSON data boundaries for arbitrary user text', () => {
    const prompt = buildDradoPrompt({ id: 'test', title: 'test', status: 'idle', createdAt: '', updatedAt: '', messages: [{ id: '1', role: 'user', content: '`$(example)`\nUSER: custom', createdAt: '' }] });
    expect(prompt).toContain('`$(example)`\\nUSER: custom');
  });
  test('does not silently truncate a full project or persist rejected input', async () => {
    const app = setup(async () => 'x'.repeat(175000)); const s = await app.create();
    await app.request(`/sessions/${s.id}/messages`, { content: 'Master' });
    await app.wait(s.id);
    const response = await app.request(`/sessions/${s.id}/messages`, { content: 'a'.repeat(10000) });
    expect(response.status).toBe(400);
    expect((await app.request(`/sessions/${s.id}`)).data.session.messages).toHaveLength(2);
  });
  test('recovers interrupted jobs on restart without discarding history', async () => {
    const app = setup(); const s = await app.create();
    const { Database } = await import('bun:sqlite');
    const db = new Database(join(app.directory, 'sessions.sqlite'));
    db.query('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify({ ...s, status: 'running', messages: [{ id: '1', role: 'user', content: 'Continue', createdAt: '' }] }), s.id); db.close();
    app.service.close(); resources[0].close = () => {};
    const reopened = createDradoRouter({ directory: app.directory, run: async () => '' }); resources[0].close = reopened.close;
    const data = await (await reopened.router.request(`/sessions/${s.id}`)).json() as any;
    expect(data.session.status).toBe('error'); expect(data.session.messages).toHaveLength(1);
  });
  test('rejects generation when Hermes is unavailable', async () => {
    const app = setup(); app.service.close(); resources[0].close = () => {};
    const service = createDradoRouter({ directory: app.directory, run: async () => 'should not run', ready: async () => false }); resources[0].close = service.close;
    const s = (await (await service.router.request('/sessions', { method: 'POST', body: '{}' })).json() as any).session;
    expect((await service.router.request(`/sessions/${s.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'test' }) })).status).toBe(503);
  });
  test('rejects cross-site requests to the local agent and allows the local UI', async () => {
    const app = setup();
    expect((await app.service.router.request('/sessions', { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await app.service.router.request('/sessions', { headers: { Origin: 'http://127.0.0.1:5173' } })).status).toBe(200);
  });
});
