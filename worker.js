// Phone Jail — Cloudflare Worker proxy. Single file, no npm.
// Secrets (set in Cloudflare dashboard, never in code):
//   OPENROUTER_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
// Or add a Workers AI binding named AI (no key needed). Optional vars: CF_MODEL, OPENROUTER_MODEL, ALLOWED_ORIGINS (comma-separated, default: any valid Origin)

// LLAMA — open-weight model, served via OpenRouter. Swap to Qwen/Gemma/Mistral by changing
// this one string (or set OPENROUTER_MODEL). Fallback if credits are needed: 'openrouter/free'
// (free router that picks any free vision-capable model; not guaranteed open-weight).
const DEFAULT_MODEL = 'meta-llama/llama-4-scout';
// Cloudflare Workers AI (used automatically when an AI binding named AI exists). Open-weight, vision-capable.
const CF_DEFAULT_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct'; // accept the license once via 'agree' in the playground
const GROQ_URL = 'https://openrouter.ai/api/v1/chat/completions'; // swap for vLLM/Ollama base URL
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map(); // ip -> [timestamps]; in-memory, per isolate (fine for a demo)

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors() } });

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT;
}

// Defensive JSON parse: if the model wraps JSON in prose, grab the first {...}
function parseJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in model output');
  return JSON.parse(m[0]);
}

// Pulls text out of either Workers AI response shape
function aiText(out) {
  if (typeof out === 'string') return out;
  const m = out?.choices?.[0]?.message;
  return (m && (m.content || m.reasoning_content)) || out?.response || '';
}

async function groq(env, messages) {
  // Retry up to 3 times if the reply has no usable JSON (models can be flaky)
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      let text, modelName;
      if (env.AI) {
        // LLAMA/GEMMA — runs on Cloudflare Workers AI (free daily allowance, no API key)
        modelName = env.CF_MODEL || CF_DEFAULT_MODEL;
        text = aiText(await env.AI.run(modelName, { messages, max_tokens: 800, temperature: 0.8 }));
      } else {
        const res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Phone Jail' },
          body: JSON.stringify({ model: env.OPENROUTER_MODEL || DEFAULT_MODEL, messages, temperature: 0.8, max_tokens: 800 }),
        });
        if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
        const data = await res.json();
        modelName = data.model;
        text = data.choices?.[0]?.message?.content || '';
      }
      try {
        return parseJson(text);
      } catch (_) {
        throw new Error(`No JSON in model output (model: ${modelName}): ${text.slice(0, 200)}`);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ELEVENLABS — spoken quest
async function tts(env, text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_turbo_v2_5' }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return res.arrayBuffer();
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function handleQuest(env, body) {
  const { lat, lng, weather, duration } = body;
  // LLAMA — quest generation
  const quest = await groq(env, [
    {
      role: 'system',
      content:
        `You design short outdoor quests that work ANYWHERE: city, village, farmland, desert or suburb. ` +
        `Reply with strict JSON only, no other text: {"title","instruction","proof_hint"}. ` +
        `You cannot know what is nearby, so never name or assume a specific place, park, pond, landmark or business. ` +
        `Build the quest from things found almost everywhere: the sky, the ground, plants, light, shadows, textures, colors, sounds, weather. ` +
        `Safety: no climbing, heights, water edges, roads or traffic, trespassing, or talking to strangers. No props, nothing to buy. ` +
        `One person on foot, doable in ${duration} minutes. Weather: ${weather}. ` +
        `Instruction under 35 words, specific, physical, a little playful. Needs exactly one photo as proof; proof_hint says what the photo should show.`,
    },
    { role: 'user', content: 'Generate the quest now.' },
  ]);
  let audio_base64 = null;
  try {
    audio_base64 = toBase64(await tts(env, quest.instruction));
  } catch (e) {
    // Cut order: ElevenLabs fails -> browser falls back to speechSynthesis
    console.log('TTS failed', e.message);
  }
  return { quest, audio_base64 };
}

async function handleVerify(env, body) {
  const { photo_base64, quest } = body;
  const url = photo_base64.startsWith('data:') ? photo_base64 : `data:image/jpeg;base64,${photo_base64}`;
  // LLAMA — vision verification
  const out = await groq(env, [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Quest: ${quest.instruction}. Does this photo plausibly prove the user did it? Reply strict JSON: {"pass": true|false, "reason": "one short sentence"}.`,
        },
        { type: 'image_url', image_url: { url } },
      ],
    },
  ]);
  return { pass: out.pass === true || out.pass === 'true', reason: String(out.reason || '') };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    const origin = request.headers.get('Origin');
    if (!origin) return json({ error: 'Origin required' }, 403);
    if (env.ALLOWED_ORIGINS && !env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin))
      return json({ error: 'Origin not allowed' }, 403);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) return json({ error: 'Rate limit: 20 requests/hour' }, 429);

    const path = new URL(request.url).pathname;
    try {
      const body = await request.json();
      if (path === '/quest') return json(await handleQuest(env, body));
      if (path === '/verify') return json(await handleVerify(env, body));
      if (path === '/tts') {
        const buf = await tts(env, body.text);
        return new Response(buf, { headers: { 'Content-Type': 'audio/mpeg', ...cors() } });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
