type Kind = 'image' | 'video';
export type MediaPricing = {
  inputUsdPerMillion: number;
  textOutputUsdPerMillion: number;
  mediaOutputUsdPerMillion: number;
  source: string;
  checkedAt: string;
};
export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cachedTokens?: number;
  toolTokens?: number;
  outputByModality?: Record<string, number>;
};
export type MediaCost = {
  currency: 'USD';
  usdMicros: number | null;
  status: 'pending' | 'estimated' | 'unavailable';
  note: string;
  pricing?: MediaPricing;
  usage?: TokenUsage;
};
const source = 'https://ai.google.dev/gemini-api/docs/pricing';
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

// Snapshot rates when a job starts, so subsequent price changes do not reprice history.
export function pricingFor(model: string, kind: Kind, baseUrl: string): MediaPricing | undefined {
  let rates: number[] | undefined;
  let google = false;
  try { google = new URL(baseUrl).hostname === 'generativelanguage.googleapis.com'; } catch { /* Invalid URLs have no default tariff. */ }
  if (google) {
    if (kind === 'image' && model === 'gemini-3-pro-image') rates = [2, 12, 120];
    if (kind === 'video' && ['gemini-omni-1.1-flash', 'gemini-omni-flash-preview'].includes(model)) rates = [1.5, 9, 17.5];
  }
  const prefix = `DRADO_${kind.toUpperCase()}`;
  const names = ['INPUT', 'TEXT_OUTPUT', 'MEDIA_OUTPUT'].map(part => `${prefix}_${part}_USD_PER_MILLION`);
  const overrides = names.map(name => Bun.env[name]?.trim());
  const custom = overrides.some(value => Boolean(value));
  if (custom) {
    // Require all three rates for a custom model/provider; partial defaults could misprice it.
    if (overrides.some(value => !value)) return undefined;
    rates = overrides.map(value => Number(value));
    if (rates.some(rate => !Number.isFinite(rate) || rate < 0)) return undefined;
  }
  if (!rates) return undefined;
  return { inputUsdPerMillion: rates[0], textOutputUsdPerMillion: rates[1], mediaOutputUsdPerMillion: rates[2], source: custom ? 'Konfigurasi backend' : source, checkedAt: custom ? new Date().toISOString() : '2026-10-16' };
}

export function responseUsage(payload: any, kind: Kind): TokenUsage | undefined {
  const raw = payload?.usageMetadata ?? payload?.usage_metadata ?? payload?.usage;
  if (!raw || typeof raw !== 'object') return undefined;
  const usage: TokenUsage = {
    inputTokens: count(raw.promptTokenCount ?? raw.prompt_token_count ?? raw.total_input_tokens),
    outputTokens: count(raw.candidatesTokenCount ?? raw.candidates_token_count ?? raw.total_output_tokens),
    thinkingTokens: count(raw.thoughtsTokenCount ?? raw.thoughts_token_count ?? raw.total_thought_tokens),
    cachedTokens: count(raw.cachedContentTokenCount ?? raw.cached_content_token_count ?? raw.total_cached_tokens),
    toolTokens: count(raw.toolUsePromptTokenCount ?? raw.tool_use_prompt_token_count ?? raw.total_tool_use_tokens),
  };
  const details = raw.candidatesTokensDetails ?? raw.candidates_tokens_details ?? raw.output_tokens_by_modality;
  if (Array.isArray(details)) {
    usage.outputByModality = {};
    for (const detail of details) {
      const tokens = count(detail?.tokenCount ?? detail?.token_count ?? detail?.tokens);
      const modality = typeof detail?.modality === 'string' ? detail.modality.toLowerCase() : '';
      if (tokens !== undefined && modality) usage.outputByModality[modality] = (usage.outputByModality[modality] || 0) + tokens;
    }
  }
  // A single actual output modality also establishes the split without guessing token counts.
  if ((!usage.outputByModality || Object.keys(usage.outputByModality).length === 0) && usage.outputTokens !== undefined) {
    const parts = kind === 'image'
      ? (payload.candidates || []).flatMap((candidate: any) => candidate.content?.parts || []).filter((part: any) => !part.thought)
      : (payload.steps || []).filter((step: any) => step.type === 'model_output').flatMap((step: any) => step.content || []);
    const modalities = new Set(parts.map((part: any) => {
      if (kind === 'video') return part.type;
      const mime = (part.inlineData || part.inline_data)?.mimeType || (part.inlineData || part.inline_data)?.mime_type;
      return mime?.startsWith('image/') ? 'image' : typeof part.text === 'string' && part.text.length ? 'text' : 'unknown';
    }));
    if (modalities.size === 1 && (modalities.has(kind) || modalities.has('text'))) {
      usage.outputByModality = { [modalities.has(kind) ? kind : 'text']: usage.outputTokens };
    }
  }
  return usage;
}

export function calculateCost(kind: Kind, pricing?: MediaPricing, usage?: TokenUsage, finalUsage = false, running = false): MediaCost {
  const base: MediaCost = { currency: 'USD', usdMicros: null, status: running && !finalUsage ? 'pending' : 'unavailable', note: 'Data usage belum tercatat.', pricing, usage };
  if (!finalUsage || !usage) return base;
  if (!pricing) return { ...base, note: 'Tarif model belum dikonfigurasi.' };
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return { ...base, note: 'Jumlah token input/output belum lengkap.' };
  if ((usage.cachedTokens || 0) > 0 || (usage.toolTokens || 0) > 0) return { ...base, note: 'Usage cache/tool memerlukan tarif tambahan.' };
  const modalities = usage.outputByModality || {};
  const media = modalities[kind];
  if (usage.outputTokens > 0 && media === undefined && modalities.text === undefined) return { ...base, note: 'Rincian token text dan media belum tersedia.' };
  if (Object.keys(modalities).some(key => !['text', kind].includes(key))) return { ...base, note: 'Modalitas output belum didukung dalam tarif.' };
  const mediaTokens = media ?? Math.max(0, usage.outputTokens - (modalities.text || 0));
  const textTokens = usage.outputTokens - mediaTokens;
  if (textTokens < 0 || (modalities.text !== undefined && modalities.text !== textTokens)) return { ...base, note: 'Rincian token tidak cocok dengan total output.' };
  // USD per million tokens × tokens = millionths of USD. Thinking is billed as text.
  const usdMicros = Math.round(usage.inputTokens * pricing.inputUsdPerMillion + (textTokens + (usage.thinkingTokens || 0)) * pricing.textOutputUsdPerMillion + mediaTokens * pricing.mediaOutputUsdPerMillion);
  if (!Number.isSafeInteger(usdMicros)) return { ...base, note: 'Nilai biaya di luar batas pencatatan.' };
  return { ...base, usdMicros, status: 'estimated', note: 'Estimasi tarif Standard dari usage API; belum termasuk pajak, kredit, atau diskon.' };
}

export function costTotals(jobs: { cost?: MediaCost; status: string }[]) {
  const priced = jobs.filter(job => job.cost?.status === 'estimated' && job.cost.usdMicros !== null);
  return {
    usdMicros: priced.reduce((total, job) => total + job.cost!.usdMicros!, 0),
    priced: priced.length,
    unpriced: jobs.filter(job => job.status !== 'running' && job.cost?.status !== 'estimated').length,
    pending: jobs.filter(job => job.status === 'running' && job.cost?.status !== 'estimated').length,
  };
}
