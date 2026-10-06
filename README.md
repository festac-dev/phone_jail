# Phone Jail

Lock your phone for 15–60 minutes. An open-weight Llama model reads your GPS + weather and invents one real-world quest. ElevenLabs reads it aloud. Go do it, come back, snap one photo. Llama vision checks it. Phone unlocks.

Built for the DEV Hacktoberfest **Touch Grass** challenge.

## How it works
Browser (`index.html`) → Cloudflare Worker (`worker.js`) → Workers AI (Llama 3.2 11B Vision) and ElevenLabs.
The worker holds the keys, so nothing secret reaches the browser.

1. Pick 15, 30 or 60 minutes and a lock mode.
2. The page gets your location (rounded) and the weather from Open-Meteo.
3. Llama writes one quest. ElevenLabs speaks it. The quest is shown on the cell screen too, with a replay button.
4. When the timer ends, take one photo. Llama vision checks it and you're free.

## Lock modes
- **Honor mode** (default): timer plus your word. You can leave the page.
- **Real lock**: a web page can't block other apps, so the page walks you through your phone's own pinning feature (Guided Access on iPhone, App pinning on Android) before it lets you start. Unpin when time is up, because a pinned phone can't open the camera.

## Why open-weight matters
- The quest designer and the photo judge are both Llama (open weights).
- Swap the model by changing one string (`CF_DEFAULT_MODEL` in `worker.js`, or the `CF_MODEL` variable).
- Without the `AI` binding the worker falls back to any OpenAI-compatible endpoint (OpenRouter, self-hosted vLLM or Ollama) via `OPENROUTER_API_KEY`.
- The Workers AI free allowance covers a demo.

## Setup
1. **Worker:** Cloudflare dashboard → Workers & Pages → Create → Worker → Edit code, paste `worker.js`, Deploy.
2. **Binding:** Settings → Bindings → Add → Workers AI, variable name `AI`.
3. **Secrets:** `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (use a voice your plan allows; free plans can't use library voices via the API).
4. **Model license:** open `@cf/meta/llama-3.2-11b-vision-instruct` in the Workers AI playground and send `agree` once.
5. **Page:** put your worker URL in `WORKER_URL` in `index.html`, then upload it to Cloudflare Pages (or any HTTPS host).
6. **Optional:** set `ALLOWED_ORIGINS` to your Pages URL so other sites can't use your worker.

Test the worker:
```bash
W=https://your-worker.workers.dev
curl -s $W/quest -H 'Origin: https://example.com' -H 'Content-Type: application/json' \
  -d '{"lat":40.7,"lng":-74.0,"weather":"clear, 18C","duration":15}' | head -c 400
```

## Environment
| Name | Kind | Purpose |
|---|---|---|
| `AI` | Binding | Workers AI (runs Llama) |
| `ELEVENLABS_API_KEY` | Secret | Voice |
| `ELEVENLABS_VOICE_ID` | Secret | Voice to use |
| `CF_MODEL` | Text, optional | Override the model |
| `ALLOWED_ORIGINS` | Text, optional | Restrict who can call the worker |

## Security notes
- Keys live only in the Worker. The worker rejects requests with no `Origin` and rate-limits to 20 requests per IP per hour.
- `Access-Control-Allow-Origin: *` is a hackathon tradeoff. A real product needs auth and per-user quotas.
- Coordinates (rounded) and the photo go to Cloudflare Workers AI. Only the quest text goes to ElevenLabs.

## Honest limits
It's a web page. It can't block other apps by itself, so the lock is the honor system unless you use Real lock mode. After two failed photo checks it releases you. The quest is the point.

## Fallbacks built in
ElevenLabs fails → browser speech. Open-Meteo fails → "clear, 20C". Fullscreen or Wake Lock unsupported → ignored.
