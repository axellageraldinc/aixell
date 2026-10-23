// The provider of nothing: it implements no capability, so every capability bound to it resolves to null and callers degrade
// (keyword heuristics, untranslated cards, no covers, no search). Used when a config names `type: "null"`.
export class NullProvider {
  constructor({ id = 'null' } = {}) { this.id = id; this.type = 'null'; }
}
