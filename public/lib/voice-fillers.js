// The short phrases the voice chat speaks while the agent is still working (the sets come from the server). Pure helpers:
// which phrase next, when, and a cache of the synthesized audio so a phrase is requested once.

// A random phrase that is not the one spoken just before, when there is a choice.
export function pickFiller(list, last = '', random = Math.random) {
  const options = list.length > 1 ? list.filter((phrase) => phrase !== last) : list;
  return options[Math.floor(random() * options.length)] ?? '';
}

// The tiers flattened to one list of waits, shortest first: [{ after: 10, phrases }, { after: 15, phrases }, ...]. `after` is how
// long to wait since the previous filler ended; the list is followed in order and its last entry repeats.
export function waitPlan(waits) {
  return waits.flatMap((tier) => tier.after.map((after) => ({ after, phrases: tier.phrases }))).sort((a, b) => a.after - b.after);
}

// Audio bytes by phrase. `fetchBytes(text)` resolves to an ArrayBuffer or rejects; a failure is remembered as null (that
// phrase is skipped) so one failing request does not turn into a request per mark.
export function createFillerCache(fetchBytes) {
  const store = new Map();
  return {
    get(text) {
      if (!store.has(text)) {
        const entry = { bytes: null, done: false };
        entry.promise = Promise.resolve()
          .then(() => fetchBytes(text))
          .then((bytes) => { entry.bytes = bytes; }, () => {})
          .finally(() => { entry.done = true; });
        store.set(text, entry);
      }
      return store.get(text).promise.then(() => store.get(text).bytes);
    },
    ready(text) {
      const entry = store.get(text);
      return Boolean(entry?.done && entry.bytes);
    },
    clear() {
      store.clear();
    },
  };
}
