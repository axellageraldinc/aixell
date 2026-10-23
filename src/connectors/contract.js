// The connector contract (JSDoc only) and its runtime validator.
//
// A connector is a small module that turns one source into candidates for the Fresh feed. Its
// `type` names the kind of source ("rss", "youtube", ...); one instance of it is configured in
// `config.json` (or comes from the shipped presets) with an id, a category, a limit and the
// connector-specific `config` object.
//
// A connector receives its context (state, providers, budget, secrets) through ConnectorContext and
// must tolerate a missing piece (`null`): the free types get no providers and no budget, and a
// metered one checks for its capability before it spends anything.

/** @typedef {Object} Candidate      // what a connector returns; normalized by fresh/normalize.js
 *  @property {string} url  @property {string} title  @property {number} ts          // epoch ms published
 *  @property {string=} snippet @property {string=} text @property {string=} image
 *  @property {string=} author @property {string=} lang                              // ISO code if known
 *  @property {string=} cat                                                            // hint; classifier may override
 *  @property {Record<string,any>=} meta   // {via, handle, gh:{repo,stars,...}, release, finished, flag ...} (today's meta.* usage)
 *  @property {{source?:string, stack?:boolean, readyCard?:Card}=} hints             // readyCard = skip writer (Steam summaries)
 */

/** @typedef {Object} ConnectorContext
 *  @property {object} config            // this instance's validated config (see registry.contextFor)
 *  @property {(ref:string)=>string|null} secret   // resolves "env:"/"file:"/"agentEnv:" refs
 *  @property {{get(k,d),set(k,v),key(k)}|null} state // per-instance KV, keys prefixed with the instance id (state.js)
 *  @property {typeof fetch} fetch                 // SSRF-guarded (fresh/net.js safeFetch; the offline mock under the switch)
 *  @property {{get(capability:string):object|null}|null} providers // provider registry lookup; null when unavailable
 *  @property {Budget|null} budget                 // reserve/settle/refund/spentToday over the shared ledger (budget.js)
 *  @property {Logger} log  @property {AbortSignal} signal  @property {()=>number} now  @property {string} timezone
 *  @property {boolean=} enabled                   // the kill switch (settings.off / settings.x.enabled)
 *  @property {boolean=} force                     // ignore the connector's own clock (the bootstrap)
 */

/** @typedef {Object} Connector
 *  @property {string} type                         // "rss" | "youtube" | "github-releases" | "ghsa" | "hn" | ...
 *  @property {string} title                        // English display name
 *  @property {object} configSchema                 // JSON-schema subset; also drives the Settings form
 *  @property {object} credentials                  // [{key,label,secret:true,required}] -> Settings shows "set/unset" only
 *  @property {ScheduleSpec} defaultSchedule        // {every:'30m'} | {at:['21:00']} | {cron:'0 0/4 * * *'}
 *  @property {{kind:'free'|'metered', costPerRunMicro?:number, requires?:string[]}} cost
 *  @property {(ctx:ConnectorContext)=>Promise<Candidate[]>} fetch
 *  @property {(ctx:ConnectorContext)=>Promise<{ok:boolean, detail?:string}>=} test      // "Test connection" button
 *  @property {(ctx:ConnectorContext)=>object=} status               // connector-specific extra (xStatus, githubStatus, steamStatus, ...)
 *  @property {(ctx:ConnectorContext, ...args:any[])=>any=} boost    // optional scoring hook (steam.boost)
 *  @property {boolean=} push                       // true for "ingest": receives instead of fetching (webhook)
 */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string' && value.trim().length > 0;

const SCHEDULE_KEYS = ['every', 'at', 'cron'];
const COST_KINDS = ['free', 'metered'];

// Returns a list of human-readable problems; an empty list means the object is a usable Connector.
// A push connector (push: true) receives items instead of fetching them, so it may omit `fetch`.
export function validateConnector(obj) {
  const errors = [];
  if (!isPlainObject(obj)) return ['connector: must be an object'];

  if (!isString(obj.type)) errors.push('type: must be a non-empty string');
  if (!isString(obj.title)) errors.push('title: must be a non-empty string');

  if (obj.push !== undefined && typeof obj.push !== 'boolean') errors.push('push: must be a boolean');
  if (obj.push !== true && typeof obj.fetch !== 'function') errors.push('fetch: must be a function');
  if (obj.fetch !== undefined && typeof obj.fetch !== 'function') errors.push('fetch: must be a function');

  if (obj.defaultSchedule !== undefined) {
    const schedule = obj.defaultSchedule;
    if (!isPlainObject(schedule)) {
      errors.push('defaultSchedule: must be an object with exactly one of every, at, cron');
    } else {
      const present = SCHEDULE_KEYS.filter((key) => schedule[key] !== undefined);
      if (present.length !== 1) errors.push('defaultSchedule: must have exactly one of every, at, cron');
      if (schedule.every !== undefined && !isString(schedule.every)) errors.push('defaultSchedule.every: must be a non-empty string');
      if (schedule.at !== undefined) {
        if (!Array.isArray(schedule.at) || !schedule.at.length || !schedule.at.every(isString)) errors.push('defaultSchedule.at: must be a non-empty array of strings');
      }
      if (schedule.cron !== undefined && !isString(schedule.cron)) errors.push('defaultSchedule.cron: must be a non-empty string');
    }
  }

  if (!isPlainObject(obj.cost)) {
    errors.push('cost: must be an object with a kind');
  } else {
    if (!COST_KINDS.includes(obj.cost.kind)) errors.push(`cost.kind: must be one of ${COST_KINDS.join(', ')}`);
    if (obj.cost.costPerRunMicro !== undefined && (typeof obj.cost.costPerRunMicro !== 'number' || !Number.isFinite(obj.cost.costPerRunMicro) || obj.cost.costPerRunMicro < 0)) {
      errors.push('cost.costPerRunMicro: must be a number >= 0');
    }
  }

  if (obj.configSchema !== undefined && !isPlainObject(obj.configSchema)) errors.push('configSchema: must be an object');
  if (obj.credentials !== undefined && !Array.isArray(obj.credentials)) errors.push('credentials: must be an array');
  if (obj.test !== undefined && typeof obj.test !== 'function') errors.push('test: must be a function');
  if (obj.status !== undefined && typeof obj.status !== 'function') errors.push('status: must be a function');

  return errors;
}
