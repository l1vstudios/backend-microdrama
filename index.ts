import { Hono } from "hono";
import { createDradoRouter, hermesRunner } from "./drado";
import { geminiScriptRunner, resolveHermesPython } from "./drado-engines";

import { cors } from "hono/cors";

import { mkdir, writeFile } from "node:fs/promises";

import { dirname, extname, join, normalize } from "node:path";

import { closeDb, sql } from "./db";

import { envNumber, envString, initEnv } from "./env";



await initEnv();



type UserRow = {

  id: string;

  username: string;

  email: string | null;

  display_name: string | null;

  role: string;

  status: string;

};



type AppBindings = {

  Variables: {

    user: UserRow;

    sessionId: string;

  };

};



const app = new Hono<AppBindings>();

const googleBaseUrl = envString(
  "GOOGLE_AI_BASE_URL",
  envString("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"),
).replace(/\/+$/, "");

const legacyApiKey = envString("API_KEY");

const googleApiKey =
  envString("GOOGLE_AI_STUDIO_API_KEY") ||
  envString("GEMINI_API_KEY") ||
  envString("GOOGLE_API_KEY") ||
  (legacyApiKey.startsWith("sk-or-") ? "" : legacyApiKey);

const textModel = envString("GOOGLE_TEXT_MODEL", envString("GEMINI_TEXT_MODEL", "gemini-3.6-flash"));

const imageModel = envString("GOOGLE_IMAGE_MODEL", envString("GEMINI_IMAGE_MODEL", "gemini-nano-banana-2.1"));

const videoModel = envString("GOOGLE_VIDEO_MODEL", envString("GEMINI_VIDEO_MODEL", "veo-3.1-generate-preview"));

const referenceImageModel = envString(
  "GOOGLE_REFERENCE_IMAGE_MODEL",
  envString("GEMINI_REFERENCE_IMAGE_MODEL", "gemini-3.1-flash-image"),
);

const hermesBin = envString("HERMES_BIN", Bun.env.HOME ? `${Bun.env.HOME}/.hermes/hermes-agent/.hermes/bin/hermes` : "hermes");

const hermesMuseTimeoutMs = Math.max(30_000, envNumber("HERMES_MUSE_TIMEOUT_MS", 180_000));

const hermesDirectorSkills = envString("HERMES_DIRECTOR_SKILLS", [
  "muse-video",
  "story_spine_narrative",
  "tiktok_vertical_platform",
  "performance_direction_micro_expression",
  "positive_prompt_structure",
  "negative_prompt_library",
  "iterative_prompt_refinement",
  "character_consistency",
  "cinematic_continuity",
  "cinematic_consistency_protocol",
  "documentary-realism-cinematography",
  "steadicam_handheld_camera",
  "cinematic-lighting-techniques",
  "natural_window_light",
  "skin_tone_inconsistency",
  "minimax_h3",
  "ltx23",
].join(","));

const imageQuality = envString("GOOGLE_IMAGE_QUALITY", envString("OPENROUTER_IMAGE_QUALITY", "medium"));

const imageOutputFormat = envString("GOOGLE_IMAGE_OUTPUT_FORMAT", envString("OPENROUTER_IMAGE_OUTPUT_FORMAT", "png"));

const googleResponseCache = envString("GOOGLE_RESPONSE_CACHE", envString("OPENROUTER_RESPONSE_CACHE", "1")).toLowerCase() !== "0";

const googleResponseCacheTtl = envNumber("GOOGLE_RESPONSE_CACHE_TTL", envNumber("OPENROUTER_RESPONSE_CACHE_TTL", 3600));

const localResponseCache = envString("LOCAL_RESPONSE_CACHE", "1").toLowerCase() !== "0";

const localResponseCacheTtl = envNumber("LOCAL_RESPONSE_CACHE_TTL_SECONDS", 604800);

const videoPromptHardLimit = 19500;

const projectSnapshotRetention = Math.max(1, Math.min(10, envNumber("PROJECT_SNAPSHOT_RETENTION", 3)));

const assetStorageDir = envString("ASSET_STORAGE_DIR", "storage/assets");

const debugBridge = envString("DEBUG_BRIDGE", "1").toLowerCase() !== "0";

const aiUsageTotals = {

  promptTokens: 0,

  completionTokens: 0,

  totalTokens: 0,

  cachedTokens: 0,

  cacheWriteTokens: 0,

  costUsd: 0,

  requests: 0,

  cacheHits: 0,

  cacheMisses: 0,

  localCacheHits: 0,

  localCacheMisses: 0,

};

const inlineVideoJobs = new Map<string, { status: string; bytes: ArrayBuffer; contentType: string; createdAt: number; model: string }>();



app.use(

  "*",

  cors({

    origin: origin => {
      const configured = envString("CORS_ORIGIN", "*");
      return configured === "*" || configured.split(",").map(value => value.trim()).includes(origin) ? origin : undefined;
    },
    credentials: true,

    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

    allowHeaders: ["Content-Type", "Authorization"],

  }),

);



// ============================================================================

// LOGGING HELPER

// ============================================================================

const dradoCaveman = {
  enabled: !/^(0|false|off)$/i.test(envString("DRADO_CAVEMAN", "1")),
  engineBin: envString("CAVEMAN_ENGINE_BIN", `${Bun.env.HOME}/.caveman/bin/caveman-engine`),
  skillPath: envString("DRADO_CAVEMAN_SKILL_PATH", `${Bun.env.HOME}/.hermes/skills/productivity/caveman/SKILL.md`),
};
const dradoSkillPath = envString("DRADO_SKILL_PATH", `${Bun.env.HOME}/.hermes/skills/drado-agent/SKILL.md`);
const dradoGeminiModel = envString("DRADO_GEMINI_SCRIPT_MODEL", textModel);
const dradoHermesRoot = envString("DRADO_HERMES_ROOT", dirname(dirname(dirname(Bun.which(hermesBin) || hermesBin))));
const dradoHermesPython = envString("DRADO_HERMES_PYTHON") || await resolveHermesPython(hermesBin, dradoHermesRoot);
const drado = createDradoRouter({
  caveman: dradoCaveman,
  skillPath: dradoSkillPath,
  hermesModel: envString("DRADO_MODEL", "openai/gpt-5.5"),
  gemini: {
    model: dradoGeminiModel,
    ready: async () => Boolean(googleApiKey) && await Bun.file(dradoSkillPath).exists(),
    run: geminiScriptRunner({ apiKey: googleApiKey, baseUrl: googleBaseUrl, model: dradoGeminiModel, skillPath: dradoSkillPath, caveman: dradoCaveman, timeoutMs: envNumber("DRADO_TIMEOUT_MS", 600_000) }),
  },
  media: {
    apiKey: googleApiKey,
    baseUrl: googleBaseUrl,
    imageModel: envString("DRADO_IMAGE_MODEL", "gemini-3-pro-image"),
    videoModel: envString("DRADO_VIDEO_MODEL", "gemini-omni-1.1-flash"),
    hermesImage: {
      root: dradoHermesRoot,
      python: dradoHermesPython,
      model: envString("DRADO_HERMES_IMAGE_MODEL", "gpt-image-2-medium"),
    },
  },
  allowedOrigins: envString("DRADO_ALLOWED_ORIGINS").split(",").map(origin => origin.trim()).filter(Boolean),
  directory: envString("DRADO_STORAGE_DIR", join(import.meta.dir, "storage", "drado")),
  run: hermesRunner(hermesBin, envNumber("DRADO_TIMEOUT_MS", 600_000), {
    model: envString("DRADO_MODEL", "openai/gpt-5.5"),
    provider: envString("DRADO_PROVIDER", "nous"),
    caveman: dradoCaveman,
    skillPath: dradoSkillPath,
  }),
  ready: async () => Boolean(Bun.which(hermesBin)) && await Bun.file(dradoSkillPath).exists(),
});
app.route("/api/drado", drado.router);

function bridgeLog(...args: any[]) {

  if (!debugBridge) return;

  // eslint-disable-next-line no-console

  console.log("[bridge]", ...args);

}



function summarizeContentParts(content: any): string {

  if (typeof content === "string") return "string";

  if (!Array.isArray(content)) return typeof content;

  const counts: Record<string, number> = {};

  for (const part of content) {

    const t = part?.type || "unknown";

    counts[t] = (counts[t] || 0) + 1;

  }

  return Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(",");

}



function countImageParts(content: any): number {

  if (!Array.isArray(content)) return 0;

  return content.filter((p) => p?.type === "image_url" || p?.type === "image").length;

}



// ============================================================================

// CHAT COMPLETIONS (Text + Gemini image gen)

// ============================================================================

app.post("/openai/v1/chat/completions", async (c) => {

  const body = await c.req.json().catch(() => ({}));

  const taskContext = extractTaskContext(body, "text");

  const cacheOptions = extractCacheOptions(body);

  const referenceManifest = extractReferenceManifest(body);

  const upstreamBody = stripBridgeTaskContext(body);

  const payload = {

    ...upstreamBody,

    model: upstreamBody.model || textModel,

    stream: false,

  };



  // ---- Diagnostic logging ----

  const firstMessage = payload.messages?.[0];

  const refCount = countImageParts(firstMessage?.content);

  bridgeLog("chat/completions", {

    model: payload.model,

    modalities: payload.modalities || null,

    image_config: payload.image_config || null,

    contentParts: summarizeContentParts(firstMessage?.content),

    referenceImages: refCount,

    referenceManifest,

    messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,

  });

  if (referenceManifest.length && refCount !== referenceManifest.length) {

    bridgeLog("chat/completions REFERENCE_COUNT_MISMATCH", {

      manifest: referenceManifest.length,

      actual: refCount,

      referenceManifest,

    });

    return c.json({

      error: {

        message: `REFERENCE_COUNT_MISMATCH: manifest=${referenceManifest.length}, actual=${refCount}. Identity reference may have been dropped before reaching the bridge.`,

      },

    }, 400);

  }



  const result = await googleFetch("/chat/completions", payload, taskContext, cacheOptions);

  if (!result.ok) {

    bridgeLog("chat/completions UPSTREAM_ERROR", result.status, String(result.payload).slice(0, 400));

    return c.json({ error: { message: result.payload } }, result.status as any);

  }



  const responseBody: any = result.payload;



  // ---- Normalize Gemini image response into standard b64_json format ----

  const normalizedImage = extractImageDataUrl(responseBody);

  if (normalizedImage) {

    // Ensure data[0].b64_json exists so frontend handles one format consistently

    const { mimeType, base64 } = splitDataUrl(normalizedImage);

    responseBody.data = Array.isArray(responseBody.data) ? responseBody.data : [];

    if (!responseBody.data[0]) {

      responseBody.data[0] = {

        b64_json: base64,

        mime_type: mimeType,

        type: "image",

      };

    }

    bridgeLog("chat/completions IMAGE_EXTRACTED", {

      mimeType,

      base64Length: base64.length,

    });

  } else {

    bridgeLog("chat/completions NO_IMAGE", {

      finishReason: responseBody?.choices?.[0]?.finish_reason || null,

      contentType: typeof responseBody?.choices?.[0]?.message?.content,

    });

  }



  responseBody.bridge = {

    service: "bun-hono-google-ai",

    upstream_model: payload.model,

    reference_images_sent: refCount,

    image_returned: Boolean(normalizedImage),

    cache_status: result.headers.get("x-google-cache-status") || result.headers.get("x-openrouter-cache-status"),

    cache_ttl: result.headers.get("x-google-cache-ttl") || result.headers.get("x-openrouter-cache-ttl"),

    reference_manifest: referenceManifest,

  };

  return c.json(responseBody);

});



// ============================================================================

// IMAGES GENERATION (GPT Image, FLUX, Seedream, Qwen, etc.)

// ============================================================================

app.post("/openai/v1/images/generations", async (c) => {

  const body = await c.req.json().catch(() => ({}));

  const taskContext = extractTaskContext(body, "image");

  const cacheOptions = extractCacheOptions(body);

  const referenceManifest = extractReferenceManifest(body);

  const upstreamBody = stripBridgeTaskContext(body);



  // ---- Build payload preserving all meaningful fields ----

  const payload: Record<string, unknown> = {

    model: upstreamBody.model || imageModel,

    prompt: upstreamBody.prompt,

    n: upstreamBody.n || 1,

  };



  // Output format & quality

  if (upstreamBody.output_format) payload.output_format = upstreamBody.output_format;

  else payload.output_format = imageOutputFormat;

  if (upstreamBody.quality) payload.quality = upstreamBody.quality;

  else payload.quality = imageQuality;



  // ---- ASPECT RATIO: pass through as-is, do NOT silently transform ----

  // Different OpenRouter models accept different values (e.g. "1:1", "2:3", "9:16", "1024x1792").

  // We pass raw value; if a model rejects it, the error will tell the user.

  const rawAspectRatio =

    cleanText(upstreamBody.aspect_ratio) ||

    cleanText(upstreamBody.aspectRatio);

  if (rawAspectRatio) payload.aspect_ratio = rawAspectRatio;



  // Size

  if (upstreamBody.size) payload.size = upstreamBody.size;



  // ---- REFERENCE IMAGES: pass in the format OpenRouter image API expects ----

  // OpenRouter images API expects input_references: [{type:"image_url", image_url:{url}}]

  const refs = imageReferences(upstreamBody.image);

  if (refs.length) payload.input_references = refs;



  // Also preserve any already-formatted input_references from upstream

  if (Array.isArray(upstreamBody.input_references) && upstreamBody.input_references.length) {

    payload.input_references = upstreamBody.input_references;

  }



  const actualReferences = Array.isArray(payload.input_references)

    ? payload.input_references

    : [];

  const actualReferenceCount = actualReferences.length;

  bridgeLog("images/generations", {

    model: payload.model,

    hasPrompt: Boolean(payload.prompt),

    promptLength: typeof payload.prompt === "string" ? payload.prompt.length : 0,

    aspect_ratio: payload.aspect_ratio || null,

    size: payload.size || null,

    quality: payload.quality || null,

    output_format: payload.output_format || null,

    referenceImages: actualReferenceCount,

    referenceManifest,

  });

  if (referenceManifest.length && actualReferenceCount !== referenceManifest.length) {

    bridgeLog("images/generations REFERENCE_COUNT_MISMATCH", {

      manifest: referenceManifest.length,

      actual: actualReferenceCount,

      referenceManifest,

    });

    return c.json({

      error: {

        message: `REFERENCE_COUNT_MISMATCH: manifest=${referenceManifest.length}, actual=${actualReferenceCount}. Identity reference may have been dropped before reaching the bridge.`,

      },

    }, 400);

  }

  const expectsIdentity = referenceManifest.some((item) =>

    item.type === "CHARACTER_MASTER" || item.type === "CHARACTER_IDENTITY_BOARD"

  );

  if (expectsIdentity && actualReferenceCount === 0) {

    return c.json({

      error: {

        message: "CHARACTER_REFERENCE_REQUIRED: anchor declares character identity but no reference image reached the bridge.",

      },

    }, 400);

  }



  const result = await googleFetch("/images", payload, taskContext, cacheOptions);

  if (!result.ok) {

    bridgeLog("images/generations UPSTREAM_ERROR", result.status, String(result.payload).slice(0, 400));

    return c.json({ error: { message: result.payload } }, result.status as any);

  }



  const responseBody: any = result.payload;

  responseBody.data = (responseBody.data || []).map((item: any) => ({

    ...item,

    mime_type: item.mime_type || item.media_type || "image/png",

  }));

  responseBody.bridge = {

    service: "bun-hono-google-ai",

    upstream_model: payload.model,

    references: actualReferenceCount,

    reference_manifest: referenceManifest,

    cache_status: result.headers.get("x-google-cache-status") || result.headers.get("x-openrouter-cache-status"),

  };

  return c.json(responseBody);

});



// ============================================================================

// VIDEO (Google media models via Gemini API)

// ============================================================================

app.get("/api/video/models", async (c) => {
  return c.json({ ok: true, models: googleVideoModels(), fetched_at: new Date().toISOString() });

});



app.post("/api/video/generations", async (c) => {

  const body = await c.req.json().catch(() => ({}));

  const prompt = clampVideoPrompt(cleanText(body.prompt));

  const anchorImage = cleanText(body.anchorImage || body.anchor_image);

  if (!prompt) return c.json({ ok: false, error: "VIDEO_PROMPT_REQUIRED" }, 400);

  if (!anchorImage) return c.json({ ok: false, error: "ANCHOR_IMAGE_REQUIRED" }, 400);



  const requestedVideoModel = normalizeGoogleVideoModel(cleanText(body.model) || videoModel);
  let effectiveVideoModel = requestedVideoModel.startsWith("veo-")
    ? requestedVideoModel
    : "veo-3.1-generate-preview";
  if (!googleVideoModels().some((model) => model.id === effectiveVideoModel)) {
    effectiveVideoModel = "veo-3.1-generate-preview";
  }
  const durationSeconds = Math.max(4, Math.min(8, Number(body.durationSeconds || body.duration || 8)));
  const resolution = cleanText(body.resolution) || "720p";
  const safeResolution = effectiveVideoModel.includes("-fast-") && resolution === "4k" ? "1080p" : resolution;
  const aspectRatio = cleanText(body.aspectRatio || body.aspect_ratio) || "9:16";

  const payload: Record<string, unknown> = {

    model: effectiveVideoModel,

    prompt,

    duration: durationSeconds,

    resolution: safeResolution,

    aspectRatio,

    generateAudio: false,

  };

  const anchor = parseDataUrl(anchorImage);
  const instance: Record<string, unknown> = { prompt };
  if (anchor) {
    instance.image = {
      bytesBase64Encoded: anchor.buffer.toString("base64"),
      mimeType: anchor.mimeType,
    };
  }

  const requestBody = {
    instances: [instance],
    parameters: {
      aspectRatio: payload.aspectRatio,
      resolution: payload.resolution,
      durationSeconds,
      personGeneration: "allow_adult",
    },
  };

  bridgeLog("video/generations", {
    requestedModel: requestedVideoModel,
    model: effectiveVideoModel,
    hasAnchor: Boolean(anchor),
    aspectRatio,
    resolution: safeResolution,
    durationSeconds,
  });

  const sendVideoRequest = async (model: string) => fetch(`${googleBaseUrl}/models/${encodeURIComponent(model)}:predictLongRunning`, {

    method: "POST",

    headers: googleHeaders(),

    body: JSON.stringify(requestBody),

  });

  let response = await sendVideoRequest(effectiveVideoModel);
  let result: any = await response.json().catch(() => ({}));
  const firstError = result?.error?.message || result?.detail || result?.message || "";
  if (!response.ok && /inlineData|imageBytes|numberOfVideos/i.test(firstError) && effectiveVideoModel !== "veo-3.1-generate-preview") {
    bridgeLog("video/generations RETRY_STANDARD_VEO", { from: effectiveVideoModel, error: firstError.slice(0, 240) });
    effectiveVideoModel = "veo-3.1-generate-preview";
    payload.model = effectiveVideoModel;
    response = await sendVideoRequest(effectiveVideoModel);
    result = await response.json().catch(() => ({}));
  }

  if (!response.ok) return c.json({ ok: false, error: result?.error?.message || result?.detail || result?.message || `HTTP_${response.status}` }, response.status as any);

  return c.json({ ok: true, job: googleOperationToJob(result), request: payload }, 202);

});



app.get("/api/video/jobs/:id", async (c) => {

  const id = decodeURIComponent(c.req.param("id"));

  const inlineJob = inlineVideoJobs.get(id);
  if (inlineJob) {
    return c.json({ ok: true, job: { id, job_id: id, generation_id: id, status: inlineJob.status, model: inlineJob.model } });
  }

  const response = await fetch(`${googleBaseUrl}/${id}`, {

    headers: googleHeaders(),

  });

  const result: any = await response.json().catch(() => ({}));

  if (!response.ok) return c.json({ ok: false, error: result?.error?.message || result?.detail || `HTTP_${response.status}` }, response.status as any);

  return c.json({ ok: true, job: googleOperationToJob(result) });

});



app.get("/api/video/jobs/:id/content", async (c) => {

  const id = decodeURIComponent(c.req.param("id"));

  const inlineJob = inlineVideoJobs.get(id);
  if (inlineJob) {
    return c.body(inlineJob.bytes, 200, { "Content-Type": inlineJob.contentType });
  }

  const operationResponse = await fetch(`${googleBaseUrl}/${id}`, {

    headers: googleHeaders(),

  });

  const operation: any = await operationResponse.json().catch(() => ({}));

  if (!operationResponse.ok) {

    const text = JSON.stringify(operation);

    return c.json({ ok: false, error: text || `HTTP_${operationResponse.status}` }, operationResponse.status as any);

  }

  const uri = extractGoogleVideoUri(operation);
  if (!uri) return c.json({ ok: false, error: "GOOGLE_VIDEO_URI_NOT_READY" }, 409);

  const response = await fetch(uri, { headers: googleHeaders(false) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return c.json({ ok: false, error: text || `HTTP_${response.status}` }, response.status as any);
  }

  const contentType = response.headers.get("content-type") || "video/mp4";

  const bytes = await response.arrayBuffer();

  return c.body(bytes, 200, { "Content-Type": contentType });

});



// ============================================================================

// CREDITS / SESSION

// ============================================================================

app.get("/credits", (c) => {

  return c.json({

    ok: true,

    service: "bun-hono-google-ai",

    fetched_at: new Date().toISOString(),

    plan: "Google AI Studio",

    quotas: [

      { id: "gemini_text", label: "GEMINI TEXT", remaining: null, total: null },

      { id: "gemini_image", label: "GEMINI IMAGE", remaining: null, total: null },

    ],

    usage_info: aiUsageTotals,

    models: [

      { model_name: textModel, display_name: "GEMINI TEXT", available: Boolean(googleApiKey) },

      { model_name: imageModel, display_name: "GEMINI IMAGE", available: Boolean(googleApiKey) },

    ],

    cache: {

      local_response_cache_enabled: localResponseCache,

      local_response_cache_ttl_seconds: localResponseCacheTtl,

      response_cache_enabled: googleResponseCache,

      response_cache_ttl_seconds: googleResponseCacheTtl,

      prompt_cache: "Local response cache aktif di backend; Gemini server-side caching tidak dipaksa dari bridge ini.",

    },

  });

});



app.get("/sessions", (c) => {

  return c.json({

    ok: true,

    ready: Boolean(googleApiKey),

    service: "bun-hono-google-ai",

    active_session: {

      source: "GOOGLE_AI_STUDIO_API_KEY/GEMINI_API_KEY/GOOGLE_API_KEY",

      authenticated: Boolean(googleApiKey),

      models: [textModel, imageModel],

    },

    candidate_sessions: [],

    cookie_export_available: false,

    cookie_cache_path: "",

    browser_order: [],

    fetched_at: new Date().toISOString(),

  });

});



app.get("/sessions/export", (c) => {

  return c.json({

    ok: false,

    service: "bun-hono-google-ai",

    detail: "Google AI Studio memakai API key, bukan cookie browser.",

  });

});



// ============================================================================

// ASSETS

// ============================================================================

app.post("/api/assets", async (c) => {

  const body = await c.req.json().catch(() => ({}));

  const parsed = parseDataUrl(cleanText(body.dataUrl || body.data_url));

  if (!parsed) return c.json({ ok: false, error: "DATA_URL_REQUIRED" }, 400);

  await mkdir(assetStorageDir, { recursive: true });

  const label = cleanText(body.label).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "asset";

  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}-${crypto.randomUUID()}${parsed.ext}`;

  const filepath = join(assetStorageDir, filename);

  await writeFile(filepath, parsed.buffer);

  return c.json({

    ok: true,

    asset: {

      url: `/api/assets/${filename}`,

      filename,

      mimeType: parsed.mimeType,

      bytes: parsed.buffer.byteLength,

    },

  }, 201);

});



app.get("/api/assets/:filename", async (c) => {

  const filename = cleanText(c.req.param("filename"));

  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return c.json({ ok: false, error: "INVALID_ASSET_NAME" }, 400);

  const filepath = normalize(join(assetStorageDir, filename));

  const storageRoot = normalize(assetStorageDir);

  if (!filepath.startsWith(storageRoot)) return c.json({ ok: false, error: "INVALID_ASSET_PATH" }, 400);

  const file = Bun.file(filepath);

  if (!(await file.exists())) return c.json({ ok: false, error: "ASSET_NOT_FOUND" }, 404);

  return new Response(file, {

    headers: {

      "Content-Type": file.type || mimeTypeFromExtension(extname(filename)),

      "Cache-Control": "public, max-age=31536000, immutable",

    },

  });

});



// ============================================================================

// HELPERS

// ============================================================================

function cleanText(value: unknown) {

  return typeof value === "string" ? value.trim() : "";

}

function clampHermesText(value: string, maxLength: number) {

  if (!value) return "";

  if (value.length <= maxLength) return value;

  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;

}

function buildMuseVideoPrompt(project: any, brief: string) {

  const title = cleanText(project?.title);

  const genre = cleanText(project?.genre);

  const premise = cleanText(project?.premise);

  const visualStyle = clampHermesText(cleanText(project?.visualStyle), 4_000);

  const storyRules = clampHermesText(cleanText(project?.storyRules), 4_000);

  if (!brief && !title && !genre && !premise) return "";

  return `Gunakan skill muse-video. Buat Creative Pack untuk drama vertikal/microdrama.

OUTPUT WAJIB:
- Bahasa Indonesia.
- Format 9:16 vertical.
- Struktur lengkap tapi praktis: logline, target audience, tone, episode plan, karakter, lokasi, prop penting, visual direction, script sample, storyboard/shot list, prompt anchor gambar, prompt video per shot.
- Cocok untuk sistem Morai: locked character/location/prop, scene anchor, image-to-video, continuity ketat.

PROJECT CURRENT STATE:
TITLE: ${title || "(belum diisi)"}
GENRE: ${genre || "Family Drama Indo"}
PREMISE: ${premise || "(belum diisi)"}
EPISODES: ${Number(project?.episodeCount || 10)}
SECONDS_PER_EPISODE: ${Number(project?.episodeDuration || 120)}
CAST_COUNT: ${Number(project?.castCount || 4)}
LOCATION_COUNT: ${Number(project?.locationCount || 4)}
IMPORTANT_PROP_COUNT: ${Number(project?.propCount || 3)}
COUNTRY: ${cleanText(project?.country) || "Indonesia"}
LANGUAGE: ${cleanText(project?.language) || "Bahasa Indonesia"}
ASPECT_RATIO: ${cleanText(project?.aspectRatio) || "9:16"}

EXISTING VISUAL STYLE:
${visualStyle || "(none)"}

EXISTING STORY GUARDRAILS:
${storyRules || "(none)"}

USER BRIEF:
${brief || "Kembangkan ide drama vertikal dari project state saat ini."}`;

}

async function runHermesMuseVideo(prompt: string, skills = "muse-video") {

  const proc = Bun.spawn([hermesBin, "--skills", skills, "-z", prompt], {
    stdout: "pipe",
    stderr: "pipe",
    env: Bun.env,
  });

  const timeout = setTimeout(() => proc.kill(), hermesMuseTimeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      return {
        ok: false,
        error: `HERMES_MUSE_FAILED_${exitCode}: ${clampHermesText(stderr || stdout || "Hermes exited without output", 2_000)}`,
        stdout: clampHermesText(stdout, 40_000),
        stderr: clampHermesText(stderr, 8_000),
      };
    }

    return { ok: true, stdout: clampHermesText(stdout, 80_000), stderr: clampHermesText(stderr, 8_000) };
  } finally {
    clearTimeout(timeout);
  }

}

function parseHermesJsonObject(value: string) {

  const text = cleanText(value).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  const start = text.indexOf("{");

  const end = text.lastIndexOf("}");

  if (start < 0 || end <= start) throw new Error("HERMES_JSON_OBJECT_NOT_FOUND");

  return JSON.parse(text.slice(start, end + 1));

}

async function runHermesJson(prompt: string, skills = hermesDirectorSkills) {
  const result = await runHermesMuseVideo(prompt, skills);
  if (!result.ok) return result;
  try {
    return { ...result, json: parseHermesJsonObject(result.stdout) };
  } catch (error: any) {
    return {
      ok: false,
      error: `HERMES_JSON_PARSE_FAILED: ${cleanText(error?.message || error) || "invalid JSON"}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

function hermesProjectSummary(project: any) {
  return `PROJECT:
TITLE: ${cleanText(project?.title) || "(belum diisi)"}
GENRE: ${cleanText(project?.genre) || "Family Drama Indo"}
PREMISE: ${cleanText(project?.premise) || "(belum diisi)"}
REGION MODE: ${cleanText(project?.regionMode) || "Indonesia"}
COUNTRY: ${cleanText(project?.country) || "Indonesia"}
LANGUAGE: ${cleanText(project?.language) || "Bahasa Indonesia"}
ASPECT_RATIO: ${cleanText(project?.aspectRatio) || "9:16"}
EPISODES: ${Number(project?.episodeCount || 10)}
SECONDS_PER_EPISODE: ${Number(project?.episodeDuration || 120)}
CAST_COUNT: ${Number(project?.castCount || 4)}
LOCATION_COUNT: ${Number(project?.locationCount || 4)}
IMPORTANT_PROP_COUNT: ${Number(project?.propCount || 3)}`;
}

function buildHermesMuseStagePrompt(stage: string, project: any) {

  const title = cleanText(project?.title);

  const genre = cleanText(project?.genre);

  const premise = cleanText(project?.premise);

  if (!title || !genre || !premise) return "";

  const visualStyle = clampHermesText(cleanText(project?.visualStyle), 6_000);

  const storyRules = clampHermesText(cleanText(project?.storyRules), 6_000);

  const common = `Gunakan skill muse-video untuk produksi microdrama vertikal Morai.
Balas JSON mentah saja. Tidak boleh markdown, komentar, code fence, atau teks di luar JSON.

PROJECT:
TITLE: ${title}
GENRE: ${genre}
PREMISE: ${premise}
REGION MODE: ${cleanText(project?.regionMode) || "Indonesia"}
COUNTRY: ${cleanText(project?.country) || "Indonesia"}
LANGUAGE: ${cleanText(project?.language) || "Bahasa Indonesia"}
ASPECT_RATIO: ${cleanText(project?.aspectRatio) || "9:16"}
EPISODES: ${Number(project?.episodeCount || 10)}
SECONDS_PER_EPISODE: ${Number(project?.episodeDuration || 120)}
CAST_COUNT: ${Number(project?.castCount || 4)}
LOCATION_COUNT: ${Number(project?.locationCount || 4)}
IMPORTANT_PROP_COUNT: ${Number(project?.propCount || 3)}`;

  if (stage === "visual-style") {
    return `${common}

TASK:
Buat reusable visual production specification untuk character master references, location references, scene anchor frames, dan AI video shots.
Wajib live-action photorealistic vertical microdrama. Jaga cultural realism, wardrobe/era lock, human scale, no cartoon, no invented plot.

RETURN SCHEMA:
{"visualStyle":"complete visual production specification"}`;
  }

  if (stage === "story-guardrails") {
    return `${common}

TASK:
Buat strict continuity/story guardrails bernomor untuk sistem Morai. Wajib mengunci continuity, locked character/costume/location/prop, no unrelated subplot, no unapproved assets, one scene per shot, dialogue exact, inner monologue/mumble rules, scene anchor authority, and image-to-video prompt compiler rules.

RETURN SCHEMA:
{"storyGuardrails":"numbered strict production rules"}`;
  }

  if (stage === "production-bible") {
    return `${common}

LOCKED VISUAL STYLE:
${visualStyle || "(none)"}

LOCKED STORY GUARDRAILS:
${storyRules || "(none)"}

TASK:
Buat Production Bible asset dasar. Jangan tulis episode, scene, dialogue, atau future twists. Buat EXACTLY jumlah asset sesuai PROJECT.
Characters harus directly serve premise, stable physical identity, one default continuity costume, region/country accurate names and wardrobe.
Locations harus reusable production sets, no humans, permanent architecture/furniture/lighting/colors.
Props hanya story-important recurring props, no trivial items, region/era accurate.

RETURN SCHEMA:
{
  "characters":[{"name":"","role":"","description":"","identity":{"age":"","gender":"","ethnicity":"","face":"","eyes":"","nose":"","lips":"","hair":"","skin":"","body":"","distinguishingMarks":""},"costume":{"outfit":"","accessories":""}}],
  "locations":[{"name":"","description":"","architecture":"","furniture":"","lighting":"","colors":""}],
  "props":[{"name":"","description":"","appearance":""}]
}`;
  }

  return "";

}

function buildHermesDirectorPlanPrompt(project: any, characters: any[], locations: any[], props: any[], targetShots: number) {
  return `Gunakan skill muse-video dan skill pendukung: story_spine_narrative, tiktok_vertical_platform, performance_direction_micro_expression, character_consistency, cinematic_continuity, prompt-engineering, cinematography, lighting, dan video-generation.
Balas JSON mentah saja. Tidak boleh markdown, komentar, code fence, atau teks di luar JSON.

TASK:
Bertindak sebagai agentic Hermes AI Director untuk drama vertikal premium. Buat showrunner/director plan yang akan mengendalikan scripting, dialogue, shot variety, prompt image anchor, prompt video, continuity, dan QA.

${hermesProjectSummary(project)}
TARGET_SHOTS_TOTAL: ${targetShots}

LOCKED VISUAL STYLE:
${clampHermesText(cleanText(project?.visualStyle), 8_000) || "(none)"}

LOCKED STORY GUARDRAILS:
${clampHermesText(cleanText(project?.storyRules), 8_000) || "(none)"}

LOCKED CAST JSON:
${JSON.stringify(characters.map((item) => ({ id: item.id, name: item.name, role: item.role, identity: item.identity, costume: item.costume })), null, 2)}

LOCKED LOCATIONS JSON:
${JSON.stringify(locations.map((item) => ({ id: item.id, name: item.name, description: item.description, architecture: item.architecture, furniture: item.furniture })), null, 2)}

LOCKED PROPS JSON:
${JSON.stringify(props.map((item) => ({ id: item.id, name: item.name, description: item.description, appearance: item.appearance })), null, 2)}

REQUIREMENTS:
- Build connected serialized drama arc, not random prompts.
- Include hook, conflict ladder, reveal ladder, emotional progression, shot variety, dialogue strategy, continuity risks, prompt/image/video rules.
- Include inter-shot bridge strategy: how gaze, posture, emotion, prop handling, camera axis, and reaction beats flow from one shot to the next so the episode does not feel patah-patah.
- Include camera transition strategy: motivated reaction cuts, match action, rack focus, gentle pan/reframe, tracking continuation, cutaway, reveal cut, and clean cliffhanger holds. Avoid stiff camera reset and random jump cuts.
- Mention exact asset IDs where relevant. Do not invent locked asset IDs.
- Keep concise enough to be injected into later Hermes prompts.

RETURN SCHEMA:
{
  "logline": "",
  "centralConflict": "",
  "seasonArc": ["act 1", "act 2", "act 3"],
  "episodeStrategy": [{"episode":1,"hook":"","conflict":"","reversal":"","cliffhanger":""}],
  "characterArcs": [{"characterId":"CHAR_001","want":"","fear":"","secret":"","turningPoints":[]}],
  "conflictLadder": [],
  "revealLadder": [],
  "shotVarietyRules": [],
  "dialogueRules": [],
  "continuityRules": [],
  "imagePromptRules": [],
  "videoEngineRules": [],
  "qaRules": []
}`;
}

function buildHermesAutoDramaPrompt(project: any, characters: any[], locations: any[], props: any[], directorPlan: string, targetShots: number) {
  return `Gunakan skill muse-video dan skill pendukung: story_spine_narrative, tiktok_vertical_platform, performance_direction_micro_expression, character_consistency, cinematic_continuity, cinematic_consistency_protocol, positive_prompt_structure, negative_prompt_library, documentary-realism-cinematography, steadicam_handheld_camera, cinematic-lighting-techniques, natural_window_light, skin_tone_inconsistency, minimax_h3, ltx23.
Balas JSON mentah saja. Tidak boleh markdown, komentar, code fence, atau teks di luar JSON.

TASK:
Bertindak sebagai agentic Hermes showrunner + scriptwriter + storyboard director + prompt director untuk Morai.
Isi otomatis full drama: episode plan, shot queue, dialogue, per-character scene prompts, camera script, anchor image direction, video prompt direction, continuity states.

${hermesProjectSummary(project)}
TARGET_SHOTS_TOTAL: ${targetShots}
VIDEO_ENGINE_TARGET: Google Veo image-to-video, one continuous moment per shot, first-frame anchor authority.

LOCKED VISUAL STYLE:
${clampHermesText(cleanText(project?.visualStyle), 8_000) || "(none)"}

LOCKED STORY GUARDRAILS:
${clampHermesText(cleanText(project?.storyRules), 8_000) || "(none)"}

AI DIRECTOR PLAN:
${clampHermesText(directorPlan, 12_000) || "(none)"}

LOCKED CAST JSON:
${JSON.stringify(characters.map((item) => ({ id: item.id, name: item.name, role: item.role, identity: item.identity, costume: item.costume })), null, 2)}

LOCKED LOCATIONS JSON:
${JSON.stringify(locations.map((item) => ({ id: item.id, name: item.name, description: item.description, architecture: item.architecture, furniture: item.furniture })), null, 2)}

LOCKED PROPS JSON:
${JSON.stringify(props.map((item) => ({ id: item.id, name: item.name, description: item.description, appearance: item.appearance })), null, 2)}

STRICT RULES:
- Use only locked characterIds/locationId/propIds from the JSON above.
- No new named characters, no new recurring locations, no new important props.
- Every shot must be one location and one continuous moment.
- Shot 1 must be OPENING_ESTABLISH, no dialogue, cinematic location opening.
- Mix shot kinds: DIALOGUE, INNER_MONOLOGUE, SOLO_ACTION, REACTION, PROP_REVEAL, CONFRONTATION, CLIFFHANGER.
- Dialogue must be natural project language and short enough for duration.
- Put exact spoken/inner lines inside characterDirections[].scenePrompt with quotes.
- For visible dialogue target, fill talkTargetId.
- Fill action, continuitySetup, plannedStartState, plannedEndState, transitionIn, transitionOut, cameraMovement, cameraScript, directAnchorPrompt.
- Every non-opening shot must include an inter-shot bridge: transitionIn explains why the edit begins here; plannedStartState continues emotion/posture/gaze/hand/prop/camera logic from prior shot when applicable; plannedEndState and transitionOut leave a smooth outgoing cut point.
- cameraScript must explicitly avoid stiff starts/stops: include small reaction hold, breath, eye shift, body turn, rack focus, gentle pan/reframe, tracking continuation, or motivated camera settle. No sudden camera jump unless story intentionally shocks.
- If shot changes location/focus, transitionIn/transitionOut must justify the cut as reaction cut, match action, reveal cut, cutaway, location establish, time-compression, or cliffhanger insert. Avoid random jumps.
- directAnchorPrompt is for first-frame image/anchor. It must be image-only, visual, no video motion phrasing.
- cameraScript and characterDirections drive video prompting.
- Include backgroundNpcMode only for public/crowd scenes; extras are nameless atmosphere only.

RETURN SCHEMA:
{
  "episodes": [{"episode":1,"logline":"","hook":"","cliffhanger":""}],
  "shots": [
    {
      "episode": 1,
      "sceneId": "EP01_SC01",
      "shotKind": "OPENING_ESTABLISH | DIALOGUE | INNER_MONOLOGUE | SOLO_ACTION | REACTION | PROP_REVEAL | CONFRONTATION | CLIFFHANGER",
      "locationId": "LOC_001",
      "characterIds": ["CHAR_001"],
      "propIds": [],
      "action": "",
      "continuitySetup": "",
      "plannedStartState": "",
      "plannedEndState": "",
      "transitionIn": "",
      "transitionOut": "",
      "movementMode": "STATIC | LOCOMOTION",
      "movingCharacterIds": [],
      "cameraMovement": "STATIC | PAN | TILT | PUSH_IN | PULL_OUT | TRACKING | HANDHELD | ORBIT | CRANE | MIXED",
      "cameraScript": "",
      "allowCutaway": false,
      "allowSceneFlexibility": false,
      "backgroundNpcMode": "NONE | LIGHT | MEDIUM | CROWD",
      "backgroundNpcDescription": "",
      "backgroundNpcMaxCount": 0,
      "directAnchorPrompt": "",
      "characterDirections": [
        {"characterId":"CHAR_001","talkTargetId":"","cameraFocus":true,"scenePrompt":""}
      ],
      "continuityNotes": []
    }
  ]
}`;
}



function mimeTypeFromExtension(ext: string) {

  const normalized = ext.toLowerCase();

  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";

  if (normalized === ".webp") return "image/webp";

  if (normalized === ".gif") return "image/gif";

  return "image/png";

}



function parseDataUrl(value: string) {

  const match = value.match(/^data:([^;,]+);base64,(.+)$/);

  if (!match) return null;

  const mimeType = match[1] || "image/png";

  if (!mimeType.startsWith("image/")) return null;

  const ext = mimeType.includes("jpeg") ? ".jpg" : mimeType.includes("webp") ? ".webp" : mimeType.includes("gif") ? ".gif" : ".png";

  return { mimeType, ext, buffer: Buffer.from(match[2], "base64") };

}



function splitDataUrl(value: string): { mimeType: string; base64: string } {

  const match = value.match(/^data:([^;]+);base64,(.+)$/);

  if (!match) return { mimeType: "image/png", base64: value };

  return { mimeType: match[1], base64: match[2] };

}



// ============================================================================

// EXTRACT IMAGE DATA URL FROM AN UPSTREAM RESPONSE

// Handles multiple possible schemas returned by OpenRouter / Gemini image models.

// ============================================================================

function extractImageDataUrl(payload: any): string | null {

  if (!payload) return null;



  // ---- OpenAI standard: data[0].b64_json ----

  if (Array.isArray(payload.data) && payload.data.length) {

    for (const item of payload.data) {

      if (!item) continue;

      if (typeof item.b64_json === "string" && item.b64_json) {

        const mime = item.mime_type || item.media_type || "image/png";

        return `data:${mime};base64,${item.b64_json}`;

      }

      if (typeof item.url === "string" && item.url.startsWith("data:image/")) {

        return item.url;

      }

    }

  }



  // ---- Chat completions style ----

  const message = payload?.choices?.[0]?.message;

  if (message) {

    // message.images[]

    if (Array.isArray(message.images) && message.images.length) {

      for (const img of message.images) {

        if (!img) continue;

        const url = img?.image_url?.url || img?.url || img?.b64_json;

        if (typeof url === "string" && url) {

          if (url.startsWith("data:image/")) return url;

          if (url.startsWith("http")) return url; // pass-through; caller handles

          if (/^[A-Za-z0-9+/=\s]{200,}$/.test(url)) return `data:image/png;base64,${url.replace(/\s+/g, "")}`;

        }

      }

    }

    // message.content[] parts

    if (Array.isArray(message.content)) {

      for (const part of message.content) {

        if (!part) continue;

        if (part.type === "image_url" && part.image_url?.url) return part.image_url.url;

        if (part.type === "image" && part.image_url?.url) return part.image_url.url;

        if (part.type === "output_image" && part.image_url?.url) return part.image_url.url;

        if (typeof part.b64_json === "string" && part.b64_json) {

          return `data:image/png;base64,${part.b64_json}`;

        }

        // Gemini native inline_data / inlineData

        const inline = part.inline_data || part.inlineData;

        if (inline && typeof inline.data === "string") {

          const mime = inline.mime_type || inline.mimeType || "image/png";

          return `data:${mime};base64,${inline.data}`;

        }

      }

    }

    // message.content as string (raw base64 or data URL)

    if (typeof message.content === "string") {

      const text = message.content.trim();

      if (text.startsWith("data:image/")) return text;

      if (/^[A-Za-z0-9+/=\s]{200,}$/.test(text)) return `data:image/png;base64,${text.replace(/\s+/g, "")}`;

    }

  }



  return null;

}

function extractInlineMedia(payload: any, mimePrefix: string) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    const mimeType = inline?.mimeType || inline?.mime_type || "";
    if (inline?.data && (!mimePrefix || mimeType.startsWith(mimePrefix))) {
      return { mimeType: mimeType || "application/octet-stream", data: inline.data };
    }
  }
  return null;
}

function normalizeGoogleModelId(requested: unknown, fallback: string) {
  const raw = cleanText(requested);
  if (!raw) return fallback;
  const withoutModels = raw.startsWith("models/") ? raw.slice("models/".length) : raw;
  const withoutGoogle = withoutModels.startsWith("google/") ? withoutModels.slice("google/".length) : withoutModels;
  if (/^(gemini|veo|imagen)-/i.test(withoutGoogle)) return withoutGoogle;
  return fallback;
}

function normalizeGoogleTextModel(requested: unknown) {
  return normalizeGoogleModelId(requested, textModel);
}

function normalizeGoogleImageModel(requested: unknown) {
  return normalizeGoogleModelId(requested, imageModel);
}

function normalizeGoogleVideoModel(requested: unknown) {
  return normalizeGoogleModelId(requested, videoModel);
}

function googleVideoModels() {
  return [
    {
      id: "veo-3.1-generate-preview",
      name: "Google: Veo 3.1",
      costPerSecond: null,
      supportedResolutions: ["720p", "1080p", "4k"],
      supportedDurations: [8],
      supportedAspectRatios: ["9:16", "16:9"],
      supportedFrameImages: ["first_frame"],
      pricingSkus: {},
      generateAudio: false,
    },
    {
      id: "veo-3.1-fast-generate-preview",
      name: "Google: Veo 3.1 Fast",
      costPerSecond: null,
      supportedResolutions: ["720p", "1080p"],
      supportedDurations: [8],
      supportedAspectRatios: ["9:16", "16:9"],
      supportedFrameImages: ["first_frame"],
      pricingSkus: {},
      generateAudio: false,
    },
  ];
}

function openAiContentToGeminiParts(content: any): any[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ text: part.text });
      continue;
    }
    const url = part?.image_url?.url || part?.image?.url || part?.url;
    if (typeof url === "string") {
      const parsed = parseDataUrl(url);
      if (parsed) {
        parts.push({
          inlineData: {
            mimeType: parsed.mimeType,
            data: parsed.buffer.toString("base64"),
          },
        });
      } else {
        parts.push({ text: `[Image reference URL omitted by Google API adapter: ${url.slice(0, 160)}]` });
      }
    }
  }
  return parts;
}

function openAiContentToText(content: any) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : cleanText(part?.text)).filter(Boolean).join("\n");
}

function openAiChatRequestToGemini(payload: any, model: string) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const systemParts: any[] = [];
  const contents: any[] = [];
  for (const message of messages) {
    const role = cleanText(message?.role);
    if (role === "system" || role === "developer") {
      const text = openAiContentToText(message?.content);
      if (text) systemParts.push({ text });
      continue;
    }
    const parts = openAiContentToGeminiParts(message?.content);
    if (!parts.length) continue;
    contents.push({
      role: role === "assistant" ? "model" : "user",
      parts,
    });
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: cleanText(payload.prompt) || "Continue." }] });

  const generationConfig: Record<string, unknown> = {};
  if (Number.isFinite(Number(payload.temperature))) generationConfig.temperature = Number(payload.temperature);
  if (Number.isFinite(Number(payload.top_p))) generationConfig.topP = Number(payload.top_p);
  if (Number.isFinite(Number(payload.max_tokens))) generationConfig.maxOutputTokens = Number(payload.max_tokens);
  if (payload.response_format?.type === "json_object") generationConfig.responseMimeType = "application/json";

  return {
    model,
    body: {
      contents,
      ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    },
  };
}

function openAiImageRequestToGemini(payload: any, model: string) {
  const prompt = cleanText(payload.prompt);
  const parts: any[] = prompt ? [{ text: prompt }] : [];
  const refs = Array.isArray(payload.input_references) ? payload.input_references : [];
  for (const ref of refs) {
    const url = ref?.image_url?.url || ref?.url || ref?.image;
    const parsed = typeof url === "string" ? parseDataUrl(url) : null;
    if (parsed) {
      parts.push({
        inlineData: {
          mimeType: parsed.mimeType,
          data: parsed.buffer.toString("base64"),
        },
      });
    }
  }

  return {
    model,
    body: {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    },
  };
}

function geminiUsageToOpenAiUsage(payload: any) {
  const usage = payload?.usageMetadata || {};
  return {
    prompt_tokens: Number(usage.promptTokenCount || 0),
    completion_tokens: Number(usage.candidatesTokenCount || 0),
    total_tokens: Number(usage.totalTokenCount || 0),
  };
}

function geminiToOpenAiChatResponse(payload: any, model: string) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part: any) => cleanText(part?.text)).filter(Boolean).join("\n");
  const imageParts = parts
    .map((part: any) => part?.inlineData || part?.inline_data)
    .filter((inline: any) => inline?.data)
    .map((inline: any) => ({
      type: "image_url",
      image_url: { url: `data:${inline.mimeType || inline.mime_type || "image/png"};base64,${inline.data}` },
      inlineData: inline,
    }));
  return {
    id: payload?.responseId || crypto.randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: imageParts.length ? [...(text ? [{ type: "text", text }] : []), ...imageParts] : text,
      },
      finish_reason: payload?.candidates?.[0]?.finishReason || "stop",
    }],
    usage: geminiUsageToOpenAiUsage(payload),
    raw_gemini: payload,
  };
}

function geminiToOpenAiImageResponse(payload: any, model: string) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const data = parts
    .map((part: any) => part?.inlineData || part?.inline_data)
    .filter((inline: any) => inline?.data)
    .map((inline: any) => ({
      b64_json: inline.data,
      mime_type: inline.mimeType || inline.mime_type || "image/png",
      type: "image",
    }));
  const text = parts.map((part: any) => cleanText(part?.text)).filter(Boolean).join("\n");
  return {
    created: Math.floor(Date.now() / 1000),
    model,
    data,
    ...(text ? { message: text } : {}),
    usage: geminiUsageToOpenAiUsage(payload),
    raw_gemini: payload,
  };
}

function extractGoogleVideoUri(operation: any) {
  return cleanText(operation?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri)
    || cleanText(operation?.response?.generatedVideos?.[0]?.video?.uri)
    || cleanText(operation?.response?.generated_videos?.[0]?.video?.uri);
}

function googleOperationToJob(operation: any) {
  const done = Boolean(operation?.done);
  const error = operation?.error?.message || operation?.error || null;
  return {
    ...operation,
    id: operation?.name,
    job_id: operation?.name,
    generation_id: operation?.name,
    status: error ? "failed" : done ? "completed" : "processing",
    error,
    video_uri: extractGoogleVideoUri(operation) || null,
  };
}



function clampVideoPrompt(value: string) {

  if (value.length <= videoPromptHardLimit) return value;

  const suffix = "\n\nFINAL HARD LOCK: continue from the attached first frame only. One location, no cuts, no new people, exact dialogue, exact cast, no story expansion.";

  return `${value.slice(0, videoPromptHardLimit - suffix.length).trim()}${suffix}`;

}



function lowestVideoSecondPrice(pricingSkus: Record<string, unknown>) {

  const values = Object.entries(pricingSkus || {})

    .filter(([key]) => key.includes("second"))

    .map(([, value]) => Number(value))

    .filter((value) => Number.isFinite(value) && value > 0);

  if (!values.length) return null;

  return Math.min(...values);

}



type AiTaskContext = {

  taskType: string;

  category: string;

};



type CacheOptions = {

  bypassCache: boolean;

};



function cleanTaskText(value: unknown, fallback: string, maxLength = 96) {

  const cleaned = cleanText(value).replace(/\s+/g, " ");

  return (cleaned || fallback).slice(0, maxLength);

}



function extractTaskContext(body: any, fallbackCategory: string): AiTaskContext {

  const metadata = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};

  return {

    taskType: cleanTaskText(

      body?.mora_task_type || body?.moraTaskType || body?.task_type || body?.taskType || metadata.mora_task_type,

      fallbackCategory,

    ),

    category: cleanTaskText(

      body?.mora_task_category || body?.moraTaskCategory || body?.task_category || body?.taskCategory || metadata.mora_task_category,

      fallbackCategory,

      32,

    ),

  };

}



type ReferenceManifestItem = {

  slot: number;

  type: string;

  id: string;

  label: string;

};



function extractReferenceManifest(body: any): ReferenceManifestItem[] {

  const raw = body?.mora_reference_manifest || body?.moraReferenceManifest || [];

  if (!Array.isArray(raw)) return [];

  return raw

    .map((item: any, index: number) => ({

      slot: Number(item?.slot || index + 1),

      type: cleanTaskText(item?.type, "REFERENCE", 64),

      id: cleanTaskText(item?.id, `REF_${index + 1}`, 96),

      label: cleanTaskText(item?.label, "", 160),

    }))

    .filter((item: ReferenceManifestItem) => item.type || item.id);

}



function extractCacheOptions(body: any): CacheOptions {

  return {

    bypassCache: body?.mora_bypass_cache === true || body?.moraBypassCache === true || body?.bypass_cache === true || body?.bypassCache === true,

  };

}



function stripBridgeTaskContext(body: any) {

  const rest = { ...(body || {}) };

  delete rest.mora_task_type;

  delete rest.moraTaskType;

  delete rest.mora_task_category;

  delete rest.moraTaskCategory;

  delete rest.task_type;

  delete rest.taskType;

  delete rest.task_category;

  delete rest.taskCategory;

  delete rest.mora_bypass_cache;

  delete rest.moraBypassCache;

  delete rest.bypass_cache;

  delete rest.bypassCache;

  delete rest.mora_reference_manifest;

  delete rest.moraReferenceManifest;

  return rest;

}



function publicUser(user: UserRow) {

  return {

    id: user.id,

    username: user.username,

    email: user.email,

    displayName: user.display_name,

    role: user.role,

    status: user.status,

  };

}



function googleHeaders(_useResponseCache = true) {

  if (!googleApiKey) throw new Error("GOOGLE_AI_STUDIO_API_KEY/GEMINI_API_KEY/GOOGLE_API_KEY belum tersedia di .env atau ~/.hermes/.env");

  const headers: Record<string, string> = {

    "x-goog-api-key": googleApiKey,

    "Content-Type": "application/json",

  };

  return headers;

}



function stableJson(value: unknown): string {

  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;

  const object = value as Record<string, unknown>;

  return `{${Object.keys(object)

    .sort()

    .filter((key) => object[key] !== undefined)

    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)

    .join(",")}}`;

}



// ============================================================================

// CACHE KEY (optimized: hash prompt + reference image hashes, NOT full base64)

// ============================================================================

async function buildCacheKey(path: string, payload: any): Promise<string> {

  // Deep clone and replace bulky image data URLs with their SHA-256 hashes

  const sanitized = await sanitizeForCache(payload);

  return await sha256(stableJson({ path, sanitized }));

}



async function sanitizeForCache(value: any): Promise<any> {

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {

    if (value.startsWith("data:image/") && value.length > 512) {

      const hash = await sha256(value);

      return `data:image#sha256:${hash}`;

    }

    return value;

  }

  if (Array.isArray(value)) {

    return await Promise.all(value.map((item) => sanitizeForCache(item)));

  }

  if (typeof value === "object") {

    const out: Record<string, any> = {};

    for (const [k, v] of Object.entries(value)) {

      out[k] = await sanitizeForCache(v);

    }

    return out;

  }

  return value;

}



function extractAiUsage(payload: any, headers: Headers) {

  const usage = payload?.usage || {};

  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};

  return {

    promptTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),

    completionTokens: Number(usage.completion_tokens || usage.output_tokens || 0),

    totalTokens: Number(usage.total_tokens || 0),

    cachedTokens: Number(details.cached_tokens || 0),

    cacheWriteTokens: Number(details.cache_write_tokens || 0),

    costUsd: Number(usage.cost || 0),

    cacheStatus: headers.get("x-google-cache-status") || headers.get("x-openrouter-cache-status") || null,

    requestId: headers.get("x-generation-id") || payload?.id || null,

  };

}



async function addAiUsage(payload: any, headers: Headers, model: string, task: AiTaskContext) {

  const usage = extractAiUsage(payload, headers);

  aiUsageTotals.promptTokens += usage.promptTokens;

  aiUsageTotals.completionTokens += usage.completionTokens;

  aiUsageTotals.totalTokens += usage.totalTokens;

  aiUsageTotals.cachedTokens += usage.cachedTokens;

  aiUsageTotals.cacheWriteTokens += usage.cacheWriteTokens;

  aiUsageTotals.costUsd += usage.costUsd;

  aiUsageTotals.requests += 1;

  const cacheStatus = (usage.cacheStatus || "").toUpperCase();

  if (cacheStatus === "HIT") aiUsageTotals.cacheHits += 1;

  if (cacheStatus === "MISS") aiUsageTotals.cacheMisses += 1;



  await sql`

    insert into ai_usage_events (

      provider, model, task_type, prompt_tokens, completion_tokens, total_tokens,

      cached_tokens, cache_write_tokens, cache_status, cost_usd, request_id, metadata

    )

    values (

      'google-ai', ${model}, ${task.taskType}, ${usage.promptTokens}, ${usage.completionTokens}, ${usage.totalTokens},

      ${usage.cachedTokens}, ${usage.cacheWriteTokens}, ${usage.cacheStatus}, ${usage.costUsd}, ${usage.requestId},

      ${sql.json({ taskCategory: task.category })}

    )

  `;

}



async function addLocalCacheHit(model: string, task: AiTaskContext, cacheKey: string) {

  aiUsageTotals.requests += 1;

  aiUsageTotals.cacheHits += 1;

  aiUsageTotals.localCacheHits += 1;

  await sql`

    insert into ai_usage_events (

      provider, model, task_type, prompt_tokens, completion_tokens, total_tokens,

      cached_tokens, cache_write_tokens, cache_status, cost_usd, request_id,

      metadata

    )

    values (

      'local-cache', ${model}, ${task.taskType}, 0, 0, 0,

      0, 0, 'LOCAL_HIT', 0, ${cacheKey},

      ${sql.json({ cacheKey, taskCategory: task.category })}

    )

  `;

}



async function addCacheBypassEvent(model: string, task: AiTaskContext) {

  await sql`

    insert into ai_usage_events (

      provider, model, task_type, prompt_tokens, completion_tokens, total_tokens,

      cached_tokens, cache_write_tokens, cache_status, cost_usd, request_id,

      metadata

    )

    values (

      'local-cache', ${model}, ${task.taskType}, 0, 0, 0,

      0, 0, 'BYPASS', 0, null,

      ${sql.json({ taskCategory: task.category })}

    )

  `;

}



async function readLocalResponseCache(cacheKey: string, model: string, task: AiTaskContext) {

  if (!localResponseCache) return null;

  const [cached] = await sql`

    update ai_response_cache

    set hit_count = hit_count + 1

    where cache_key = ${cacheKey}

      and expires_at > now()

    returning response_body

  `;

  if (!cached) return null;

  await addLocalCacheHit(model, task, cacheKey);

  return cached.response_body;

}



async function writeLocalResponseCache(

  cacheKey: string,

  endpoint: string,

  model: string,

  requestBody: any,

  responseBody: any,

) {

  if (!localResponseCache) return;

  // Do NOT store the full base64 request bodies — strip image data for storage

  const sanitizedRequest = await sanitizeForCache(requestBody);

  await sql`

    insert into ai_response_cache (

      cache_key, endpoint, model, request_body, response_body, usage, expires_at

    )

    values (

      ${cacheKey}, ${endpoint}, ${model}, ${sql.json(sanitizedRequest)}, ${sql.json(responseBody)},

      ${sql.json(responseBody?.usage || {})}, now() + (${localResponseCacheTtl} || ' seconds')::interval

    )

    on conflict (cache_key) do update set

      response_body = excluded.response_body,

      usage = excluded.usage,

      expires_at = excluded.expires_at,

      request_body = excluded.request_body,

      model = excluded.model,

      endpoint = excluded.endpoint

  `;

}



async function googleFetch(path: string, payload: any, task: AiTaskContext, options: CacheOptions = { bypassCache: false }) {

  const hasImageReferences = path === "/images"
    && Array.isArray(payload.input_references)
    && payload.input_references.length > 0;
  const requestedModel = path === "/images"
    ? normalizeGoogleImageModel(payload.model || imageModel)
    : normalizeGoogleTextModel(payload.model || textModel);
  const model = path === "/images"
    ? (hasImageReferences ? normalizeGoogleImageModel(referenceImageModel) : requestedModel)
    : normalizeGoogleTextModel(payload.model || textModel);
  const upstreamPayload = path === "/images"
    ? openAiImageRequestToGemini(payload, model)
    : openAiChatRequestToGemini(payload, model);

  if (path === "/images" && model !== requestedModel) {
    bridgeLog("images/generations REFERENCE_MODEL_FALLBACK", {
      requestedModel,
      model,
      references: payload.input_references.length,
    });
  }

  const cacheKey = await buildCacheKey(path, upstreamPayload);

  if (options.bypassCache) {

    await addCacheBypassEvent(model, task);

  } else {

    const cached = await readLocalResponseCache(cacheKey, model, task);

    if (cached) {

      bridgeLog("LOCAL_CACHE_HIT", path, cacheKey.slice(0, 16));

      return {

        ok: true,

        status: 200,

        payload: cached,

        headers: new Headers({

          "x-google-cache-status": "LOCAL_HIT",

          "x-google-cache-ttl": String(localResponseCacheTtl),

        }),

      };

    }

  }



  if (localResponseCache && !options.bypassCache) aiUsageTotals.localCacheMisses += 1;

  const response = await fetch(`${googleBaseUrl}/models/${encodeURIComponent(model)}:generateContent`, {

    method: "POST",

    headers: googleHeaders(!options.bypassCache),

    body: JSON.stringify(upstreamPayload.body),

  });

  const geminiResult: any = await response.json().catch(() => ({}));

  if (!response.ok) {

    bridgeLog("UPSTREAM_FETCH_FAIL", path, response.status, JSON.stringify(geminiResult).slice(0, 400));

    return {

      ok: false,

      status: response.status,

      payload: geminiResult?.error?.message || geminiResult?.detail || geminiResult?.message || geminiResult,

      headers: response.headers,

    };

  }

  const result = path === "/images"
    ? geminiToOpenAiImageResponse(geminiResult, model)
    : geminiToOpenAiChatResponse(geminiResult, model);

  await addAiUsage(result, response.headers, model, task);

  if (!options.bypassCache) await writeLocalResponseCache(cacheKey, path, model, upstreamPayload.body, result);

  return { ok: true, status: response.status, payload: result, headers: response.headers };

}



function imageReferences(image: unknown) {

  const values = typeof image === "string" ? [image] : Array.isArray(image) ? image : [];

  return values

    .filter((value) => typeof value === "string" && value.trim())

    .map((value) => ({ type: "image_url", image_url: { url: value } }));

}



function makeToken() {

  const bytes = crypto.getRandomValues(new Uint8Array(32));

  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

  return `${crypto.randomUUID()}.${encoded}`;

}



async function sha256(value: string) {

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

}



async function createSession(userId: string, token: string, c: any) {

  const tokenHash = await sha256(token);

  const days = envNumber("SESSION_DAYS", 30);

  const userAgent = c.req.header("user-agent") || null;

  const forwardedFor = c.req.header("x-forwarded-for") || "";

  const ipAddress = forwardedFor.split(",")[0]?.trim() || null;

  const [session] = await sql`

    insert into user_sessions (user_id, token_hash, user_agent, ip_address, expires_at)

    values (${userId}, ${tokenHash}, ${userAgent}, ${ipAddress}, now() + (${days} || ' days')::interval)

    returning id

  `;

  return session.id as string;

}



async function authMiddleware(c: any, next: any) {

  const header = c.req.header("authorization") || "";

  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) return c.json({ ok: false, error: "UNAUTHORIZED" }, 401);



  const tokenHash = await sha256(match[1]);

  const [row] = await sql`

    select

      s.id as session_id,

      u.id, u.username, u.email, u.display_name, u.role, u.status

    from user_sessions s

    join app_users u on u.id = s.user_id

    where s.token_hash = ${tokenHash}

      and s.revoked_at is null

      and s.expires_at > now()

      and u.status = 'active'

    limit 1

  `;

  if (!row) return c.json({ ok: false, error: "UNAUTHORIZED" }, 401);

  c.set("sessionId", row.session_id);

  c.set("user", {

    id: row.id,

    username: row.username,

    email: row.email,

    display_name: row.display_name,

    role: row.role,

    status: row.status,

  });

  await next();

}



async function requireWorkspaceMember(workspaceId: string, userId: string) {

  const [row] = await sql`

    select role from workspace_members

    where workspace_id = ${workspaceId} and user_id = ${userId}

    limit 1

  `;

  return row || null;

}



async function requireProjectAccess(projectId: string, userId: string) {

  const [row] = await sql`

    select p.*

    from projects p

    join workspace_members wm on wm.workspace_id = p.workspace_id

    where p.id = ${projectId} and wm.user_id = ${userId}

    limit 1

  `;

  return row || null;

}



// ============================================================================

// HEALTH / DB

// ============================================================================

app.get("/health", async (c) => {

  const [db] = await sql`select current_database() as database, current_user as user`;

  return c.json({

    ok: true,

    service: "microdrama-mora-api",

    database: db.database,

    dbUser: db.user,

    googleAiStudioKey: googleApiKey ? "present" : "missing",

    googleBaseUrl,

    textModel,

    imageModel,

    referenceImageModel,

    videoModel,

    videoAdapterVersion: "google-veo-bytesBase64Encoded-2026-10-08",

    hermesBin,

    cacheEnabled: googleResponseCache,

    debugBridge,

  });

});



app.post("/api/hermes/muse-video", async (c) => {

  try {

    const body = await c.req.json().catch(() => ({}));

    const project = body?.project && typeof body.project === "object" ? body.project : {};

    const brief = clampHermesText(cleanText(body.brief), 12_000);

    const prompt = buildMuseVideoPrompt(project, brief);

    if (!prompt) return c.json({ ok: false, error: "MUSE_BRIEF_REQUIRED" }, 400);

    const result = await runHermesMuseVideo(prompt);

    if (!result.ok) return c.json({ ok: false, error: result.error, stderr: result.stderr }, 502);

    return c.json({ ok: true, creativePack: result.stdout, stderr: result.stderr });

  } catch (error: any) {

    return c.json({ ok: false, error: `HERMES_MUSE_ROUTE_FAILED: ${cleanText(error?.message || error) || "unknown error"}` }, 502);

  }

});

app.post("/api/hermes/stage", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const project = body?.project && typeof body.project === "object" ? body.project : {};
    const stage = cleanText(body.stage);
    if (!["visual-style", "story-guardrails", "production-bible"].includes(stage)) {
      return c.json({ ok: false, error: "HERMES_STAGE_INVALID" }, 400);
    }
    const prompt = buildHermesMuseStagePrompt(stage, project);
    if (!prompt) return c.json({ ok: false, error: "HERMES_STAGE_PROJECT_REQUIRED" }, 400);
    const result: any = await runHermesJson(prompt, hermesDirectorSkills);
    if (!result.ok) return c.json({ ok: false, error: result.error, stdout: result.stdout, stderr: result.stderr }, 502);
    return c.json({ ok: true, stage, data: result.json, stdout: result.stdout, stderr: result.stderr });
  } catch (error: any) {
    return c.json({ ok: false, error: `HERMES_STAGE_ROUTE_FAILED: ${cleanText(error?.message || error) || "unknown error"}` }, 502);
  }
});

app.post("/api/hermes/director-plan", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const project = body?.project && typeof body.project === "object" ? body.project : {};
    const characters = Array.isArray(body.characters) ? body.characters : [];
    const locations = Array.isArray(body.locations) ? body.locations : [];
    const props = Array.isArray(body.props) ? body.props : [];
    const targetShots = Math.max(1, Math.min(120, Number(body.targetShots || 24)));
    const prompt = buildHermesDirectorPlanPrompt(project, characters, locations, props, targetShots);
    const result: any = await runHermesJson(prompt, hermesDirectorSkills);
    if (!result.ok) return c.json({ ok: false, error: result.error, stdout: result.stdout, stderr: result.stderr }, 502);
    return c.json({ ok: true, data: result.json, stdout: result.stdout, stderr: result.stderr });
  } catch (error: any) {
    return c.json({ ok: false, error: `HERMES_DIRECTOR_PLAN_ROUTE_FAILED: ${cleanText(error?.message || error) || "unknown error"}` }, 502);
  }
});

app.post("/api/hermes/auto-drama", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const project = body?.project && typeof body.project === "object" ? body.project : {};
    const characters = Array.isArray(body.characters) ? body.characters : [];
    const locations = Array.isArray(body.locations) ? body.locations : [];
    const props = Array.isArray(body.props) ? body.props : [];
    const directorPlan = clampHermesText(cleanText(body.directorPlan), 20_000);
    const targetShots = Math.max(1, Math.min(120, Number(body.targetShots || 24)));
    const prompt = buildHermesAutoDramaPrompt(project, characters, locations, props, directorPlan, targetShots);
    const result: any = await runHermesJson(prompt, hermesDirectorSkills);
    if (!result.ok) return c.json({ ok: false, error: result.error, stdout: result.stdout, stderr: result.stderr }, 502);
    return c.json({ ok: true, data: result.json, stdout: result.stdout, stderr: result.stderr });
  } catch (error: any) {
    return c.json({ ok: false, error: `HERMES_AUTO_DRAMA_ROUTE_FAILED: ${cleanText(error?.message || error) || "unknown error"}` }, 502);
  }
});

app.get("/api/db/tables", async (c) => {

  const rows = await sql`

    select table_name

    from information_schema.tables

    where table_schema = 'public'

    order by table_name

  `;

  return c.json({ ok: true, tables: rows.map((row) => row.table_name) });

});



app.get("/api/usage/logs", async (c) => {

  const limit = Math.min(Math.max(Number(c.req.query("limit") || 250), 1), 1000);

  const rows = await sql`

    select *

    from ai_usage_events

    order by created_at desc

    limit ${limit}

  `;

  return c.json({ ok: true, usage: rows });

});



// ============================================================================

// WORKSPACES / SNAPSHOTS

// ============================================================================

app.get("/api/workspaces/local", async (c) => {

  const rows = await sql`

    select

      w.*,

      p.id as project_id,

      (

        select ps.id

        from project_snapshots ps

        where ps.project_id = p.id

        order by ps.created_at desc

        limit 1

      ) as latest_snapshot_id

    from workspaces w

    left join lateral (

      select id from projects

      where workspace_id = w.id

      order by updated_at desc

      limit 1

    ) p on true

    order by w.updated_at desc

  `;

  return c.json({ ok: true, workspaces: rows });

});



app.post("/api/workspaces/local", async (c) => {

  const body = await c.req.json().catch(() => ({}));

  const name = cleanText(body.name);

  if (!name) return c.json({ ok: false, error: "WORKSPACE_NAME_REQUIRED" }, 400);

  const workspace = await sql.begin(async (tx) => {

    const [created] = await tx`

      insert into workspaces (name, description)

      values (${name}, ${cleanText(body.description) || null})

      returning *

    `;

    const [project] = await tx`

      insert into projects (workspace_id, title, created_by)

      values (${created.id}, ${name}, null)

      returning id

    `;

    return { ...created, project_id: project.id };

  });

  return c.json({ ok: true, workspace }, 201);

});



app.patch("/api/workspaces/local/:id", async (c) => {

  const body = await c.req.json().catch(() => ({}));

  const name = cleanText(body.name);

  if (!name) return c.json({ ok: false, error: "WORKSPACE_NAME_REQUIRED" }, 400);

  const [workspace] = await sql`

    update workspaces

    set name = ${name}

    where id = ${c.req.param("id")}

    returning *

  `;

  if (!workspace) return c.json({ ok: false, error: "WORKSPACE_NOT_FOUND" }, 404);

  await sql`

    update projects

    set title = case when title = '' or title is null then ${name} else title end

    where workspace_id = ${workspace.id}

  `;

  return c.json({ ok: true, workspace });

});



app.delete("/api/workspaces/local/:id", async (c) => {

  const rows = await sql`delete from workspaces where id = ${c.req.param("id")} returning id`;

  if (!rows.length) return c.json({ ok: false, error: "WORKSPACE_NOT_FOUND" }, 404);

  return c.json({ ok: true });

});



app.get("/api/workspaces/local/:id/snapshot", async (c) => {

  const workspaceId = c.req.param("id");

  const [row] = await sql`

    select ps.*

    from project_snapshots ps

    join projects p on p.id = ps.project_id

    where p.workspace_id = ${workspaceId}

    order by ps.created_at desc

    limit 1

  `;

  return c.json({ ok: true, snapshot: row || null });

});



app.put("/api/workspaces/local/:id/snapshot", async (c) => {

  const workspaceId = c.req.param("id");

  const body = await c.req.json().catch(() => ({}));

  const snapshot = body.snapshot;

  if (!snapshot || typeof snapshot !== "object") {

    return c.json({ ok: false, error: "SNAPSHOT_OBJECT_REQUIRED" }, 400);

  }

  const projectTitle = cleanText(snapshot?.project?.title) || cleanText(body.title) || "Untitled Project";

  const saved = await sql.begin(async (tx) => {

    let [project] = await tx`

      select * from projects

      where workspace_id = ${workspaceId}

      order by updated_at desc

      limit 1

    `;

    if (!project) {

      [project] = await tx`

        insert into projects (workspace_id, title)

        values (${workspaceId}, ${projectTitle})

        returning *

      `;

    } else {

      [project] = await tx`

        update projects set

          title = ${projectTitle},

          genre = ${cleanText(snapshot?.project?.genre) || null},

          premise = ${cleanText(snapshot?.project?.premise) || null},

          region_mode = ${cleanText(snapshot?.project?.regionMode) || "Indonesia"},

          country = ${cleanText(snapshot?.project?.country) || "Indonesia"},

          language = ${cleanText(snapshot?.project?.language) || "Bahasa Indonesia"},

          visual_style = ${cleanText(snapshot?.project?.visualStyle) || null},

          story_rules = ${cleanText(snapshot?.project?.storyRules) || null},

          schema_version = ${Number(snapshot?.schemaVersion || body.schemaVersion || 1)}

        where id = ${project.id}

        returning *

      `;

    }

    const [latestSnapshot] = await tx`

      select id

      from project_snapshots

      where project_id = ${project.id}

      order by created_at desc

      limit 1

    `;

    const [savedSnapshot] = latestSnapshot

      ? await tx`

          update project_snapshots

          set snapshot = ${sql.json(snapshot)},

              schema_version = ${Number(snapshot?.schemaVersion || body.schemaVersion || 1)},

              created_at = now()

          where id = ${latestSnapshot.id}

          returning *

        `

      : await tx`

          insert into project_snapshots (project_id, snapshot, schema_version)

          values (${project.id}, ${sql.json(snapshot)}, ${Number(snapshot?.schemaVersion || body.schemaVersion || 1)})

          returning *

        `;

    await tx`

      delete from project_snapshots

      where project_id = ${project.id}

        and id not in (

          select id

          from project_snapshots

          where project_id = ${project.id}

          order by created_at desc

          limit ${projectSnapshotRetention}

        )

    `;

    await tx`update workspaces set updated_at = now() where id = ${workspaceId}`;

    return { project, snapshot: savedSnapshot };

  });

  return c.json({ ok: true, ...saved }, 201);

});



// ============================================================================

// AUTH

// ============================================================================

app.post("/api/auth/register", async (c) => {

  const body = await c.req.json().catch(() => ({}));

  const username = cleanText(body.username).toLowerCase();

  const email = cleanText(body.email).toLowerCase() || null;

  const password = cleanText(body.password);

  const displayName = cleanText(body.displayName || body.display_name) || username;



  if (!username || username.length < 3) return c.json({ ok: false, error: "USERNAME_MIN_3" }, 400);

  if (!password || password.length < 8) return c.json({ ok: false, error: "PASSWORD_MIN_8" }, 400);



  const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });

  try {

    const result = await sql.begin(async (tx) => {

      const [user] = await tx<UserRow[]>`

        insert into app_users (username, email, password_hash, display_name)

        values (${username}, ${email}, ${passwordHash}, ${displayName})

        returning id, username, email, display_name, role, status

      `;

      const [workspace] = await tx`

        insert into workspaces (owner_id, name)

        values (${user.id}, ${displayName || username || "Workspace"})

        returning id, name

      `;

      await tx`

        insert into workspace_members (workspace_id, user_id, role)

        values (${workspace.id}, ${user.id}, 'owner')

      `;

      return { user, workspace };

    });

    const token = makeToken();

    await createSession(result.user.id, token, c);

    return c.json({ ok: true, user: publicUser(result.user), workspace: result.workspace, token }, 201);

  } catch (error: any) {

    if (error?.code === "23505") return c.json({ ok: false, error: "USER_ALREADY_EXISTS" }, 409);

    throw error;

  }

});



app.post("/api/auth/login", async (c) => {

  const body = await c.req.json().catch(() => ({}));

  const login = cleanText(body.login || body.username || body.email).toLowerCase();

  const password = cleanText(body.password);

  if (!login || !password) return c.json({ ok: false, error: "LOGIN_REQUIRED" }, 400);



  const [user] = await sql<(UserRow & { password_hash: string })[]>`

    select id, username, email, password_hash, display_name, role, status

    from app_users

    where (username = ${login} or email = ${login}) and status = 'active'

    limit 1

  `;

  if (!user) return c.json({ ok: false, error: "INVALID_LOGIN" }, 401);



  const valid = await Bun.password.verify(password, user.password_hash);

  if (!valid) return c.json({ ok: false, error: "INVALID_LOGIN" }, 401);



  await sql`update app_users set last_login_at = now() where id = ${user.id}`;

  const token = makeToken();

  await createSession(user.id, token, c);

  return c.json({ ok: true, user: publicUser(user), token });

});



app.get("/api/auth/me", authMiddleware, async (c) => {

  return c.json({ ok: true, user: publicUser(c.get("user")) });

});



app.post("/api/auth/logout", authMiddleware, async (c) => {

  await sql`update user_sessions set revoked_at = now() where id = ${c.get("sessionId")}`;

  return c.json({ ok: true });

});



// ============================================================================

// WORKSPACES (authenticated) / PROJECTS

// ============================================================================

app.get("/api/workspaces", authMiddleware, async (c) => {

  const user = c.get("user");

  const rows = await sql`

    select w.*, wm.role as member_role

    from workspaces w

    join workspace_members wm on wm.workspace_id = w.id

    where wm.user_id = ${user.id}

    order by w.updated_at desc

  `;

  return c.json({ ok: true, workspaces: rows });

});



app.post("/api/workspaces", authMiddleware, async (c) => {

  const user = c.get("user");

  const body = await c.req.json().catch(() => ({}));

  const name = cleanText(body.name);

  if (!name) return c.json({ ok: false, error: "WORKSPACE_NAME_REQUIRED" }, 400);



  const workspace = await sql.begin(async (tx) => {

    const [created] = await tx`

      insert into workspaces (owner_id, name, description)

      values (${user.id}, ${name}, ${cleanText(body.description) || null})

      returning *

    `;

    await tx`

      insert into workspace_members (workspace_id, user_id, role)

      values (${created.id}, ${user.id}, 'owner')

    `;

    return created;

  });

  return c.json({ ok: true, workspace }, 201);

});



app.get("/api/projects", authMiddleware, async (c) => {

  const user = c.get("user");

  const workspaceId = cleanText(c.req.query("workspaceId"));

  const rows = workspaceId

    ? await sql`

        select p.*

        from projects p

        join workspace_members wm on wm.workspace_id = p.workspace_id

        where wm.user_id = ${user.id} and p.workspace_id = ${workspaceId}

        order by p.updated_at desc

      `

    : await sql`

        select p.*

        from projects p

        join workspace_members wm on wm.workspace_id = p.workspace_id

        where wm.user_id = ${user.id}

        order by p.updated_at desc

      `;

  return c.json({ ok: true, projects: rows });

});



app.post("/api/projects", authMiddleware, async (c) => {

  const user = c.get("user");

  const body = await c.req.json().catch(() => ({}));

  const workspaceId = cleanText(body.workspaceId || body.workspace_id);

  if (!workspaceId) return c.json({ ok: false, error: "WORKSPACE_ID_REQUIRED" }, 400);

  const member = await requireWorkspaceMember(workspaceId, user.id);

  if (!member) return c.json({ ok: false, error: "WORKSPACE_FORBIDDEN" }, 403);



  const [project] = await sql`

    insert into projects (

      workspace_id, title, genre, premise, region_mode, country, language,

      visual_style, story_rules, settings, schema_version, created_by

    )

    values (

      ${workspaceId},

      ${cleanText(body.title)},

      ${cleanText(body.genre) || null},

      ${cleanText(body.premise) || null},

      ${cleanText(body.regionMode || body.region_mode) || "Indonesia"},

      ${cleanText(body.country) || "Indonesia"},

      ${cleanText(body.language) || "Bahasa Indonesia"},

      ${cleanText(body.visualStyle || body.visual_style) || null},

      ${cleanText(body.storyRules || body.story_rules) || null},

      ${sql.json(body.settings || {})},

      ${Number(body.schemaVersion || body.schema_version || 1)},

      ${user.id}

    )

    returning *

  `;

  return c.json({ ok: true, project }, 201);

});



app.get("/api/projects/:id", authMiddleware, async (c) => {

  const project = await requireProjectAccess(c.req.param("id"), c.get("user").id);

  if (!project) return c.json({ ok: false, error: "PROJECT_NOT_FOUND" }, 404);

  return c.json({ ok: true, project });

});



app.put("/api/projects/:id", authMiddleware, async (c) => {

  const user = c.get("user");

  const projectId = c.req.param("id");

  const existing = await requireProjectAccess(projectId, user.id);

  if (!existing) return c.json({ ok: false, error: "PROJECT_NOT_FOUND" }, 404);



  const body = await c.req.json().catch(() => ({}));

  const [project] = await sql`

    update projects set

      title = coalesce(${cleanText(body.title) || null}, title),

      genre = coalesce(${cleanText(body.genre) || null}, genre),

      premise = coalesce(${cleanText(body.premise) || null}, premise),

      region_mode = coalesce(${cleanText(body.regionMode || body.region_mode) || null}, region_mode),

      country = coalesce(${cleanText(body.country) || null}, country),

      language = coalesce(${cleanText(body.language) || null}, language),

      visual_style = coalesce(${cleanText(body.visualStyle || body.visual_style) || null}, visual_style),

      story_rules = coalesce(${cleanText(body.storyRules || body.story_rules) || null}, story_rules),

      settings = coalesce(${body.settings ? sql.json(body.settings) : null}, settings),

      schema_version = coalesce(${body.schemaVersion || body.schema_version || null}, schema_version)

    where id = ${projectId}

    returning *

  `;

  return c.json({ ok: true, project });

});



app.get("/api/projects/:id/snapshot", authMiddleware, async (c) => {

  const projectId = c.req.param("id");

  const project = await requireProjectAccess(projectId, c.get("user").id);

  if (!project) return c.json({ ok: false, error: "PROJECT_NOT_FOUND" }, 404);



  const [snapshot] = await sql`

    select * from project_snapshots

    where project_id = ${projectId}

    order by created_at desc

    limit 1

  `;

  return c.json({ ok: true, snapshot: snapshot || null });

});



app.put("/api/projects/:id/snapshot", authMiddleware, async (c) => {

  const user = c.get("user");

  const projectId = c.req.param("id");

  const project = await requireProjectAccess(projectId, user.id);

  if (!project) return c.json({ ok: false, error: "PROJECT_NOT_FOUND" }, 404);



  const body = await c.req.json().catch(() => ({}));

  if (!body.snapshot || typeof body.snapshot !== "object") {

    return c.json({ ok: false, error: "SNAPSHOT_OBJECT_REQUIRED" }, 400);

  }

  const [latestSnapshot] = await sql`

    select id

    from project_snapshots

    where project_id = ${projectId}

    order by created_at desc

    limit 1

  `;

  const [snapshot] = latestSnapshot

    ? await sql`

        update project_snapshots

        set user_id = ${user.id},

            snapshot = ${sql.json(body.snapshot)},

            schema_version = ${Number(body.schemaVersion || body.schema_version || 1)},

            created_at = now()

        where id = ${latestSnapshot.id}

        returning *

      `

    : await sql`

        insert into project_snapshots (project_id, user_id, snapshot, schema_version)

        values (${projectId}, ${user.id}, ${sql.json(body.snapshot)}, ${Number(body.schemaVersion || body.schema_version || 1)})

        returning *

      `;

  return c.json({ ok: true, snapshot }, 201);

});



app.get("/api/usage", authMiddleware, async (c) => {

  const user = c.get("user");

  const rows = await sql`

    select *

    from ai_usage_events

    where user_id = ${user.id}

    order by created_at desc

    limit 100

  `;

  return c.json({ ok: true, usage: rows });

});



// ============================================================================

// SERVER

// ============================================================================

const port = envNumber("PORT", 8788);



console.log(`microdrama-mora API listening on http://localhost:${port}`);

console.log(`  text model:  ${textModel}`);

console.log(`  image model: ${imageModel}`);

console.log(`  video model: ${videoModel}`);

console.log(`  provider:    Google AI Studio (${googleBaseUrl})`);

console.log(`  debug log:   ${debugBridge ? "ON" : "OFF"}`);

console.log(`  local cache: ${localResponseCache ? "ON" : "OFF"}`);

console.log(`  drado:       ${envString("DRADO_PROVIDER", "nous")} / ${envString("DRADO_MODEL", "openai/gpt-5.5")}`);
console.log(`  caveman:     ${dradoCaveman.enabled ? 'ON (concise output + lossless history)' : 'OFF'}`);

console.log(`  drado image: ${envString("DRADO_IMAGE_MODEL", "gemini-3-pro-image")}`);

console.log(`  drado video: ${envString("DRADO_VIDEO_MODEL", "gemini-omni-1.1-flash")}`);



const server = Bun.serve({

  port,
  hostname: envString("HOST", "127.0.0.1"),

  fetch: app.fetch,

});



process.on("SIGINT", async () => {

  drado.close();

  await closeDb();

  server.stop();

  process.exit(0);

});
