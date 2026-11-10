// The real models behind one turn: the one in effect when it began, then every change until it ended. `trail` is the
// server's [{ts, model}] list of gateway pin changes (empty for a plain model).
export function turnModels(trail, start, end) {
  if (!Array.isArray(trail) || trail.length === 0 || start == null) return [];
  const until = end ?? Infinity;
  const names = [];
  let before = null;
  for (const entry of trail) {
    if (entry.ts <= start) before = entry.model;
    else if (entry.ts <= until) names.push(entry.model);
  }
  return [...new Set([before, ...names].filter(Boolean))];
}
