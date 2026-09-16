// Thin client for a locally-running Ollama instance. The browser talks to
// Ollama directly (no backend in between) - Ollama must be started with
// OLLAMA_ORIGINS set to allow this page's origin.

export class OllamaError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'OllamaError';
    this.cause = cause;
  }
}

function friendlyConnectError(host) {
  return new OllamaError(
    `Could not reach Ollama at ${host}. Make sure Ollama is running locally and started with ` +
    `an OLLAMA_ORIGINS value that allows this page's origin (${location.origin}), e.g.:\n` +
    `  OLLAMA_ORIGINS=${location.origin} ollama serve`
  );
}

export async function listModels(host) {
  let res;
  try {
    res = await fetch(`${host.replace(/\/$/, '')}/api/tags`);
  } catch (err) {
    throw friendlyConnectError(host);
  }
  if (!res.ok) throw new OllamaError(`Ollama returned HTTP ${res.status} listing models`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

// Sends a chat request and returns { text, promptTokens, completionTokens }
// once complete. Streams internally so long generations don't look hung,
// with progress optionally reported via onToken. Token counts come from
// Ollama's own accounting (prompt_eval_count/eval_count on the final
// streamed line) - they're undefined if an Ollama version omits them, and
// callers should fall back to the heuristic estimator in js/tokens.js.
export async function chat({ host, model, system, prompt, onToken, format }) {
  const url = `${host.replace(/\/$/, '')}/api/chat`;
  const body = {
    model,
    stream: true,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
  };
  if (format) body.format = format;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw friendlyConnectError(host);
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new OllamaError(`Ollama returned HTTP ${res.status}${text ? `: ${text}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  let promptTokens;
  let completionTokens;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line);
      if (chunk.message?.content) {
        full += chunk.message.content;
        if (onToken) onToken(chunk.message.content, full);
      }
      if (chunk.done) {
        promptTokens = chunk.prompt_eval_count;
        completionTokens = chunk.eval_count;
      }
      if (chunk.error) throw new OllamaError(chunk.error);
    }
  }

  return { text: full, promptTokens, completionTokens };
}

// Extracts the first top-level JSON object/array found in a model response,
// tolerating surrounding prose or markdown code fences.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('No JSON found in model response');
  const openChar = candidate[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === openChar) depth++;
    else if (candidate[i] === closeChar) {
      depth--;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1));
      }
    }
  }
  throw new Error('Unterminated JSON in model response');
}
