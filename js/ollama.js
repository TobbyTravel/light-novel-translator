// Thin client for a locally-running Ollama instance. The browser talks to
// Ollama directly (no backend in between) - Ollama must be started with
// OLLAMA_ORIGINS set to allow this page's origin.
import { findRefusalPhrases } from './refusal.js';

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

// Sampling defaults tuned for translation/extraction-style tasks (mechanical
// transformation of given text, not open-ended reasoning): thinking is off
// by default - many locally-run models are "thinking" models that otherwise
// spend most of their budget on an internal reasoning chain before ever
// emitting the actual answer (see numPredict comment below), which is both
// slow and, combined with a tight numPredict, can cut off the real output
// entirely. Temperature/top_p/top_k follow the models' own non-thinking-mode
// guidance: low enough variance to stay faithful to the source, not so low
// it behaves like greedy decoding (which degenerates into repetition).
const DEFAULT_THINK = false;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_P = 0.8;
const DEFAULT_TOP_K = 20;

// Sends a chat request and returns { text, promptTokens, completionTokens }
// once complete. Streams internally so long generations don't look hung,
// with progress optionally reported via onToken. Token counts come from
// Ollama's own accounting (prompt_eval_count/eval_count on the final
// streamed line) - they're undefined if an Ollama version omits them, and
// callers should fall back to the heuristic estimator in js/tokens.js.
export async function chat({
  host, model, system, prompt, onToken, format, numPredict, signal,
  think = DEFAULT_THINK, temperature = DEFAULT_TEMPERATURE, topP = DEFAULT_TOP_P, topK = DEFAULT_TOP_K,
}) {
  const url = `${host.replace(/\/$/, '')}/api/chat`;
  const body = {
    model,
    stream: true,
    think,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
    options: { temperature, top_p: topP, top_k: topK },
  };
  if (format) body.format = format;
  // Caps a single call's generation length so a model stuck in a
  // repetition loop (no EOS token) can't run forever and monopolize
  // Ollama's generation slot, starving every later request indefinitely.
  if (numPredict) body.options.num_predict = numPredict;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
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
  let refusedEarly = false;
  let refusalReasons = [];

  // A genuine refusal shows up as a preamble at the very start of a
  // response ("I cannot assist with that..."), so only scan the opening of
  // the response, not the whole thing. This matters for grouped batches:
  // without this window, an incidental phrase match deep in an EARLIER,
  // already-good chapter's dialogue would cancel the stream and lose every
  // later chapter in the same batch too. Once past the window we stop
  // scanning and rely on the post-completion per-chapter detectRefusal
  // check instead (js/translation.js, js/extraction.js).
  const EARLY_ABORT_SCAN_WINDOW = 500;
  readLoop: while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new OllamaError(`Lost connection to Ollama mid-response: ${err.message}`, err);
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch (err) {
        throw new OllamaError(`Ollama sent an unparseable response line: ${line.slice(0, 200)}`, err);
      }
      if (chunk.message?.content) {
        full += chunk.message.content;
        if (onToken) onToken(chunk.message.content, full);
        if (full.length <= EARLY_ABORT_SCAN_WINDOW) {
          const matches = findRefusalPhrases(full);
          if (matches.length > 0) {
            refusedEarly = true;
            refusalReasons = matches;
            await reader.cancel().catch(() => {});
            break readLoop;
          }
        }
      }
      if (chunk.done) {
        promptTokens = chunk.prompt_eval_count;
        completionTokens = chunk.eval_count;
      }
      if (chunk.error) throw new OllamaError(chunk.error);
    }
  }

  return { text: full, promptTokens, completionTokens, refusedEarly, refusalReasons };
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
