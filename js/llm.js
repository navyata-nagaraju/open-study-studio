// llm.js — talks to the AI model.
//
// The app supports two providers behind one function, complete(). The rest of
// the app never needs to know which one is in use. The browser calls the
// provider directly with the user's own API key, so there is no server to run
// and the key never passes through anyone else.

export const PROVIDERS = {
  gemini: {
    label: "Google Gemini (has a free tier)",
    defaultModel: "gemini-2.5-flash",
    keyHint: "Starts with AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  anthropic: {
    label: "Anthropic Claude",
    defaultModel: "claude-sonnet-5-5",
    keyHint: "Starts with sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
};

function request(settings, prompt, stream, maxTokens, json) {
  const model = settings.model || PROVIDERS[settings.provider].defaultModel;
  if (settings.provider === "anthropic") {
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        // Required for calls made straight from a web page.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, stream, messages: [{ role: "user", content: prompt }] }),
    });
  }
  const action = stream ? "streamGenerateContent?alt=sse&" : "generateContent?";
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${action}key=${encodeURIComponent(settings.apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) },
    }),
  });
}

// Pulls the new text out of one streamed event, whichever provider sent it.
function textFromEvent(provider, event) {
  if (provider === "anthropic") return event.type === "content_block_delta" && event.delta && event.delta.text ? event.delta.text : "";
  const parts = event.candidates && event.candidates[0] && event.candidates[0].content && event.candidates[0].content.parts;
  return parts ? parts.map((p) => p.text || "").join("") : "";
}
function textFromReply(provider, body) {
  if (provider === "anthropic") return (body.content || []).map((c) => c.text || "").join("");
  return textFromEvent(provider, body);
}

async function explainError(res) {
  let detail = "";
  try { const body = await res.json(); detail = (body.error && body.error.message) || ""; } catch (_) {}
  if (res.status === 400 && /api key/i.test(detail)) return "The API key wasn't accepted. Check it in Settings.";
  if (res.status === 401 || res.status === 403) return "The API key wasn't accepted. Check it in Settings.";
  if (res.status === 404) return "That model name wasn't found. Check the model in Settings.";
  if (res.status === 429) return "The AI provider's rate limit was reached. Wait a minute and try again.";
  return `The AI provider returned an error (${res.status}). ${detail}`.trim();
}

// Sends one prompt and returns the full reply text.
// onText(fullTextSoFar) is called as the reply streams in, so lessons appear word by word.
export async function complete(settings, prompt, { onText, maxTokens = 2500, json = false } = {}) {
  if (!settings || !settings.apiKey) throw new Error("Add an AI key in Settings first.");
  const stream = typeof onText === "function";
  let res;
  try { res = await request(settings, prompt, stream, maxTokens, json); }
  catch (_) { throw new Error("Couldn't reach the AI provider. Check your internet connection."); }
  if (!res.ok) throw new Error(await explainError(res));

  if (!stream) return textFromReply(settings.provider, await res.json());

  // Server-sent events: the reply arrives as lines starting with "data: ".
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const piece = textFromEvent(settings.provider, JSON.parse(data));
        if (piece) { full += piece; onText(full); }
      } catch (_) { /* ignore keep-alive or partial lines */ }
    }
  }
  return full;
}

// Asks for JSON and parses it, tolerating ```json fences or text around the object.
export async function completeJson(settings, prompt, opts = {}) {
  const text = await complete(settings, prompt + "\n\nReply with the JSON object only.", { ...opts, json: true });
  return parseJson(text);
}

export function parseJson(text) {
  const clean = String(text).replace(/```(?:json)?/g, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The AI reply wasn't in the expected format. Try again.");
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch (_) { throw new Error("The AI reply wasn't in the expected format. Try again."); }
}
