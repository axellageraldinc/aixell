// The provider contracts (JSDoc only). A provider INSTANCE is built from one entry of the `providers` config and may
// implement any of the capability objects below. The registry (registry.js) binds capabilities to instances.
//
// Capability names (config key under `capabilities`): writer, classifier, images, socialSearch, transcription, speech, models.
//
// ProviderInstance: { id, type, text?, classify?, image?, search?, transcribe?, speech?, catalog? }
//
// text.chat({ model, messages: {role, content}[], maxTokens?, temperature?, reasoningEffort?, timeoutMs? })
//   -> Promise<{ text }>. Throws ProviderError (status, retryAfter) when the service refuses.
//
// classify.classify({ state, tasks, model?, timeoutMs? }) -> Promise<Record<id, { choice?, score?, p? }>>
//   task = { id, type: 'choice', item, question, options: Record<key, description> }
//        | { id, type: 'score',  item, question, scale: string[] }            answer.score = index into scale (0..n-1)
//        | { id, type: 'bool',   item, question, true: string, false: string } answer.p = probability of yes, 0..1
//   classify.maxTasksPerCall: number
//
// image.generate({ prompt, model, size?, timeoutMs? }) -> Promise<{ bytes: Buffer|null, mime }>
//
// search.search({ query, topic?, lang?, filter?: { allowedHandles?, excludedHandles?, from? }, timeoutMs? })
//   `query` is a prose request for providers that answer with an LLM; `topic` (the bare subject) and `lang` (a language code)
//   are for keyword engines such as x-api.
//   -> Promise<{ answer, citations, costMicro, raw }>; also search.label, search.endpoint, search.pricing
//
// transcribe.transcribe({ audio: Buffer, mime, hint?, model?, timeoutMs? }) -> Promise<{ text }>
//
// speech.synthesize({ text, model?, voice?, format?, timeoutMs? }) -> Promise<{ audio: Buffer, mime }>   (text to speech)
//
// catalog: load(), listModels({ currentModel }), priceOf(modelId), currency(), usage?({ provider, currentModel })
export {};
