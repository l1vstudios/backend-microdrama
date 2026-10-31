import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createMediaRouter } from './drado-media';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

test('new image jobs and legacy Auto/2K requests send HD 1K to Gemini and persist it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drado-hd-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const sizes: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    sizes.push(body.generationConfig.imageConfig.imageSize);
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('9:16');
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=' } }] } }] });
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = original; });
  const media = createMediaRouter({ directory, getSession: id => id === 'fixture' ? { messages: [{ id: 'assistant', role: 'assistant' }] } : undefined, config: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', imageModel: 'gemini-3-pro-image', videoModel: 'fixture' } });
  cleanups.push(media.close);
  const app = new Hono().route('/sessions/:id/media', media.router);
  let index = 0;
  for (const imageSize of [undefined, '1K', '2K', 'auto']) {
    const response = await app.request('/sessions/fixture/media', { method: 'POST', body: JSON.stringify({ kind: 'image', messageId: 'assistant', targetId: `S${++index}`, prompt: 'A cinematic frame', aspectRatio: '9:16', imageSize }) });
    expect(response.status).toBe(202);
    const { job } = await response.json() as any;
    expect(job.imageSize).toBe('1K');
    let completed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const { jobs } = await (await app.request('/sessions/fixture/media')).json() as any;
      const saved = jobs.find((item: any) => item.id === job.id);
      if (saved.status !== 'running') {
        expect(saved.status).toBe('completed');
        expect(saved.imageSize).toBe('1K');
        completed = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(completed).toBe(true);
  }
  const invalid = await app.request('/sessions/fixture/media', { method: 'POST', body: JSON.stringify({ kind: 'image', messageId: 'assistant', targetId: 'invalid', prompt: 'Frame', imageSize: '4K' }) });
  expect(invalid.status).toBe(400);
  expect(sizes).toEqual(['1K', '1K', '1K', '1K']);
});
