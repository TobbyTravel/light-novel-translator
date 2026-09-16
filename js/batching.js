// Greedily packs items into the fewest consecutive batches such that
// estimateFn(batch) stays under budget. Never splits a single item across
// batches - if one item alone exceeds budget, it becomes its own
// (over-budget) batch rather than being dropped or truncated.
export function packIntoBatches(items, estimateFn, budget) {
  const batches = [];
  let current = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (estimateFn(candidate) > budget && current.length > 0) {
      batches.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
