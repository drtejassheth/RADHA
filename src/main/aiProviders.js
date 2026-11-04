// AI providers for the narrative summary. Runs in the main process so API keys never reach the page.
// Claude uses the official Anthropic SDK; ChatGPT, Gemini, Ollama, Pollinations and custom endpoints
// share the OpenAI-compatible chat-completions shape; Sarvam reuses sarvam.js.
import Anthropic from '@anthropic-ai/sdk';
import { sarvamChat } from './sarvam.js';

export const PROVIDERS = [
  {
    id: 'pollinations', name: 'Pollinations — free, no key', kind: 'openai', needsKey: false, free: true,
    chatUrl: () => 'https://text.pollinations.ai/openai', defaultModel: 'openai',
    note: 'Free public service run by pollinations.ai. No account needed; may be slow or rate-limited, and the data is processed on their servers.',
  },
  {
    id: 'ollama', name: 'Ollama — local, free', kind: 'openai', needsKey: false, local: true,
    chatUrl: (s) => `${trimSlash(s.ollamaUrl)}/v1/chat/completions`, defaultModel: '',
    note: 'Runs a model on this computer (install from ollama.com, then e.g. "ollama pull llama3.2"). Nothing leaves your machine.',
  },
  {
    id: 'sarvam', name: 'Sarvam AI', kind: 'sarvam', needsKey: true, defaultModel: 'sarvam-105b',
    note: 'Uses the same Sarvam key as parsing and translation.',
  },
  {
    id: 'openai', name: 'ChatGPT (OpenAI)', kind: 'openai', needsKey: true,
    chatUrl: () => 'https://api.openai.com/v1/chat/completions', modelsUrl: () => 'https://api.openai.com/v1/models', defaultModel: 'gpt-5-mini',
    note: 'API key from platform.openai.com (separate from a ChatGPT subscription).',
  },
  {
    id: 'gemini', name: 'Google Gemini', kind: 'openai', needsKey: true,
    chatUrl: () => 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    modelsUrl: () => 'https://generativelanguage.googleapis.com/v1beta/openai/models', defaultModel: 'gemini-2.5-flash',
    note: 'API key from aistudio.google.com (has a free tier).',
  },
  {
    id: 'anthropic', name: 'Claude (Anthropic)', kind: 'anthropic', needsKey: true, defaultModel: 'claude-opus-5-5',
    note: 'API key from platform.claude.com.',
  },
  {
    id: 'custom', name: 'Custom (OpenAI-compatible)', kind: 'openai', needsKey: false, optionalKey: true,
    chatUrl: (s) => `${trimSlash(s.customBaseUrl)}/chat/completions`, modelsUrl: (s) => `${trimSlash(s.customBaseUrl)}/models`, defaultModel: '',
    note: 'Any OpenAI-compatible endpoint, e.g. OpenRouter (https://openrouter.ai/api/v1), Groq (https://api.groq.com/openai/v1) or LM Studio (http://localhost:1234/v1).',
  },
];

const BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
const stripThinking = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
/** The narrative is shown as plain text: drop Markdown emphasis/heading marks some models add anyway. */
const plainText = (t) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/^\s*\*\s+/gm, '- ').trim();

// Claude models that accept the server-side refusal fallback ("default" form).
const CLAUDE_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const CLAUDE_EFFORT_MODELS = /^claude-(fable|opus|sonnet|haiku)-5/;

export function getProvider(id) {
  const p = BY_ID[id];
  if (!p) throw new Error(`Unknown AI provider: ${id}`);
  return p;
}

async function httpError(res, label) {
  let msg = `${res.status} ${res.statusText}`;
  try {
    let body = await res.json();
    if (Array.isArray(body)) body = body[0]; // Gemini wraps errors in an array
    msg = body?.error?.message || body?.message || body?.detail || JSON.stringify(body).slice(0, 300);
  } catch { /* keep status text */ }
  return new Error(`${label}: ${msg}`);
}

async function openaiChat(p, messages, { model, key, settings }) {
  const url = p.chatUrl(settings);
  if (!/^https?:\/\//.test(url)) throw new Error(`${p.name}: set the server URL in Settings first.`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw await httpError(res, p.name);
  const body = await res.json();
  const text = stripThinking(body?.choices?.[0]?.message?.content);
  if (!text) throw new Error(`${p.name} returned an empty response.`);
  return text;
}

async function claudeChat(messages, { model, key }) {
  const client = new Anthropic({ apiKey: key });
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const fallback = CLAUDE_FALLBACK_MODELS.has(model);
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      ...(system ? { system } : {}),
      ...(CLAUDE_EFFORT_MODELS.test(model) ? { output_config: { effort: 'medium' } } : {}),
      // If Claude declines on safety grounds, re-run on Anthropic's recommended fallback model.
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
    });
    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}. Try another provider.`);
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw new Error('Claude returned an empty response.');
    return text;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Claude: the API key was rejected. Check it in Settings.');
    if (err instanceof Anthropic.NotFoundError) throw new Error(`Claude: model "${model}" was not found. Use "Load models" in Settings.`);
    if (err instanceof Anthropic.RateLimitError) throw new Error('Claude: rate limit reached — try again in a minute.');
    if (err instanceof Anthropic.APIError) throw new Error(`Claude: ${err.message}`);
    throw err;
  }
}

/** Send a chat request to the chosen provider. `messages` use {role: system|user|assistant, content}. */
export async function aiChat(providerId, messages, { model, key, settings }) {
  const p = getProvider(providerId);
  model = (model || p.defaultModel || '').trim();
  if (p.needsKey && !key) throw new Error(`${p.name} needs an API key. Add it in Settings → AI providers.`);
  if (!model) throw new Error(`Choose a model for ${p.name} first (Settings → AI providers → Load models).`);
  let text;
  if (p.kind === 'anthropic') text = await claudeChat(messages, { model, key });
  else if (p.kind === 'sarvam') text = await sarvamChat(messages, key, { model });
  else text = await openaiChat(p, messages, { model, key, settings });
  return plainText(text);
}

/** List the models a provider offers (for the model picker). */
export async function aiListModels(providerId, { key, settings }) {
  const p = getProvider(providerId);
  if (p.kind === 'sarvam') return ['sarvam-105b', 'sarvam-105b-conversations'];
  if (p.needsKey && !key) throw new Error(`Add the ${p.name} API key first.`);
  if (p.kind === 'anthropic') {
    const client = new Anthropic({ apiKey: key });
    const ids = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  }
  let url;
  let pick;
  if (p.id === 'ollama') { url = `${trimSlash(settings.ollamaUrl)}/api/tags`; pick = (b) => (b.models || []).map((m) => m.name); }
  else if (p.id === 'pollinations') { url = 'https://text.pollinations.ai/models'; pick = (b) => (Array.isArray(b) ? b : []).map((m) => m.name); }
  else { url = p.modelsUrl(settings); pick = (b) => (b.data || []).map((m) => String(m.id).replace(/^models\//, '')); }
  const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(20_000) })
    .catch((e) => { throw new Error(p.id === 'ollama' ? 'Ollama is not running on this computer (start the Ollama app, then retry).' : `${p.name}: ${e.message}`); });
  if (!res.ok) throw await httpError(res, p.name);
  let ids = pick(await res.json());
  if (p.id === 'openai') ids = ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id));
  if (p.id === 'gemini') ids = ids.filter((id) => /gemini/.test(id) && !/(embedding|image|tts|live)/.test(id));
  return ids.sort();
}
