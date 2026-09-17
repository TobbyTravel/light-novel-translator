// Small collapsible panel showing the current batch's streaming output text
// as it arrives from Ollama. In-memory only, not persisted per-token - only
// the job's summary token counters persist (see js/jobs.js).
export function createLiveOutputPanel(container) {
  container.innerHTML = `
    <details class="live-output">
      <summary>Live output</summary>
      <pre id="live-output-text"></pre>
    </details>
  `;
  const pre = container.querySelector('#live-output-text');
  return {
    reset() {
      pre.textContent = '';
    },
    onToken(_chunk, full) {
      pre.textContent = full;
      pre.scrollTop = pre.scrollHeight;
    },
  };
}
