// Shared singleton (module-level state - ES modules are already singletons)
// decoupling WHERE a run's live status/output is generated (autopilot,
// extraction, translation) from WHERE it's displayed (the persistent
// activity bar in index.html, outside the router-controlled #app subtree).
// This is what lets an in-progress run's status/live-output survive a
// subtab remount or navigating to another page entirely: callers write to
// this module instead of DOM nodes that a route change can detach.
let state = { statusText: '', liveText: '', running: false };
const listeners = new Set();

export function activityStart() {
  state = { statusText: 'Starting...', liveText: '', running: true };
  notify();
}

export function activitySetStatus(text) {
  state.statusText = text;
  notify();
}

export function activityPushToken(_chunk, full) {
  state.liveText = full;
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
