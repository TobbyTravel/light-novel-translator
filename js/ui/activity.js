// Shared singleton (module-level state - ES modules are already singletons)
// decoupling WHERE a run's live status/output is generated (autopilot,
// extraction, translation) from WHERE it's displayed (the persistent
// activity bar in index.html, outside the router-controlled #app subtree).
// This is what lets an in-progress run's status/live-output survive a
// subtab remount or navigating to another page entirely: callers write to
// this module instead of DOM nodes that a route change can detach.
let state = { statusText: '', liveText: '', running: false };
const listeners = new Set();

// Off by default. Every caller wires onToken straight to activityPushToken
// (see js/ui/translate-view.js and friends) regardless of whether the user
// wants to see it, so a per-token full-text string copy + <pre> textContent
// reflow (js/ui/activity-bar.js) would otherwise fire for every streamed
// token of every batch - real cost over a multi-hour, hundreds-of-batches
// run. Gating here, in the one shared sink, avoids touching every call site.
let liveOutputEnabled = false;
// Throttles the DOM-facing notify() while tokens are streaming so a long
// completion doesn't repaint on every single token - state.liveText itself
// is still kept current for whenever the next notify does fire.
const LIVE_OUTPUT_THROTTLE_MS = 250;
let lastTokenNotify = 0;

export function setLiveOutputEnabled(enabled) {
  liveOutputEnabled = !!enabled;
}

export function activityStart() {
  state = { statusText: 'Starting...', liveText: '', running: true };
  lastTokenNotify = 0;
  notify();
}

export function activitySetStatus(text) {
  state.statusText = text;
  notify();
}

export function activityPushToken(_chunk, full) {
  if (!liveOutputEnabled) return;
  state.liveText = full;
  const now = Date.now();
  if (now - lastTokenNotify < LIVE_OUTPUT_THROTTLE_MS) return;
  lastTokenNotify = now;
  notify();
}

export function activityFinish() {
  state.running = false;
  notify();
}

export function getActivityState() {
  return state;
}

export function subscribeActivity(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function notify() {
  listeners.forEach((fn) => fn(state));
}
