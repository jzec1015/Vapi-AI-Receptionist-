// Plumber rules the server checks, so Emma's prompt can stay short (a long prompt made her skip read-backs).
// ruleTags reads Emma's saved summary plus what the caller said, and returns tags such as 'active_water' or 'renter'.
// Urgent tags make a job URGENT even when Emma forgot the prefix; flag tags go on the owner's alert.
// Research and sources: emma/research/plumber-rules-research-2026-10-16.md (ops repo).

// Each trigger: tag, owner-facing label, urgent (job becomes URGENT), the phrases that set it (one alternation, word-bounded
// as a whole) and optionally 'unless': a phrase in the same sentence that cancels it ("hot water smells like rotten eggs").
// Several entries may share a tag.
const T = (tag, label, urgent, re, unless) => ({ tag, label, urgent, re: new RegExp(`\\b(?:${re})\\b`), unless: unless && new RegExp(unless) });
export const TRIGGERS = [
  T('gas', 'Gas smell (caller told to leave and call 911 or the gas company)', true,
    "smell(?:s|ed|ing)? (?:of |like )?(?:natural )?gas|gas (?:smell|leak|odor)|hissing (?:by|near|from) the (?:stove|water heater|heater|meter)"),
  T('gas', 'Gas smell (caller told to leave and call 911 or the gas company)', true, 'rotten eggs?', '\\bwater\\b'),
  T('carbon_monoxide', 'Carbon monoxide alarm', true, 'carbon monoxide|co (?:alarm|detector)'),
  T('injury', 'Someone hurt, burned or shocked', true, "(?:got|was|been|is|am|getting) (?:burned|burnt|shocked|electrocuted|hurt)|injured|electrocuted"),
  T('electrical_water', 'Water near electrical', true,
    "water\\b.{0,40}\\b(?:outlets?|electrical (?:panel|box|outlets?)|breaker (?:box|panel)|light fixture|ceiling light|wiring)|(?:outlets?|electrical panel|breaker (?:box|panel)|light fixture|ceiling light)\\b.{0,30}\\b(?:water|wet|dripping)|sparking|sparks (?:coming|flying|everywhere)"),
  T('active_water', 'Water running now (burst pipe or flooding)', true,
    "(?:burst|busted|split|cracked) (?:water )?(?:pipes?|lines?)|pipes?\\b.{0,25}\\b(?:burst|busted|broke|split|cracked|blew)|water(?: is|'s| was)? (?:everywhere|spraying|pouring|gushing|shooting|all over)|flooding|(?:is|'s|are|got|getting) flooded|coming (?:in )?through the ceiling|ceiling(?: is|'s)? (?:leaking|dripping|bulging|sagging|caving)|water won'?t stop|can'?t (?:shut|turn) (?:it|the water) off|leaking (?:really |real )?(?:bad|badly)",
    "\\b(?:last (?:year|month|week|spring|summer|fall|winter)|years? ago|months? ago|used to|was fixed|got fixed|fixed it|install|floodlight)"),
  T('sewage_backup', 'Sewage backing up', true,
    "sewage(?: is|'s)? (?:coming|backing|backed|in the|on the|everywhere|all over)|sewer(?: is|'s)? (?:backing|backed|coming) up|(?:comes|coming|came) up (?:in|into|through) the (?:tub|shower|bathtub|floor drain)|(?:toilet|commode)(?: is|'s| keeps)? overflowing|overflowing (?:toilet|commode)|every drain\\w* (?:is |are )?(?:backed|backing)"),
  T('water_heater_leak', 'Water heater pouring water or relief valve going off', true,
    "(?:water heater|hot water (?:heater|tank)|heater|tank)\\b.{0,30}\\b(?:pouring|spraying|gushing|flooding|leaking (?:really |real )?(?:bad|badly))|(?:relief valve|t ?(?:&|and|n) ?p(?: valve)?|pipe on the side of the (?:water heater|heater|tank))\\b.{0,30}\\b(?:spray\\w*|gushing|pouring|going off|blowing|shooting)|(?:water|it'?s) (?:is )?(?:coming|shooting|spraying|pouring) out (?:of )?the (?:pipe|valve) on the side of the (?:water heater|heater|tank)"),
  T('scalding', 'Scalding hot tap water', true, "scalded|scalding|(?:water|tap|faucet)(?: is|'s)? (?:way |too |dangerously |extremely )+hot", 'anti.?scald'),
  T('sump_failure', 'Sump pump failing', true, "sump\\b.{0,30}\\b(?:alarm|failed|failing|not (?:running|working|pumping)|stopped|quit|died|broke)", "\\b(?:backup sump|install|last (?:year|month|spring))"),
  T('no_water', 'No water at all', true,
    "no water (?:at all|anywhere|in the (?:house|home))|(?:don'?t|do not) have (?:any )?water(?! (?:pressure|heater))|nothing comes out of (?:any|every|all)(?: of)? (?:the )?(?:faucets?|taps?)|water(?: is|'s)? (?:cut|shut) off|(?:well|well pump)(?: is|'s)? (?:out|dead|quit|not working)"),
  T('frozen_pipe', 'Frozen pipe', true, "(?:pipes?|lines?|water) (?:are |is |'s |have |has |got )?(?:froze|frozen)|froze(?:n)? (?:pipes?|lines?)"),
  // Not urgent on their own: the owner sees them as flags.
  T('no_hot_water', 'No hot water', false, "no hot water|hot water(?: is|'s)? (?:out|gone)"),
  T('slab_leak', 'Possible slab leak', false, 'slab leak|(?:warm|hot) spot on the floor|water bill (?:went|is) (?:way )?up|hear water running'),
  T('warranty_company', 'Home warranty company job (check rate before accepting)', false,
    'home warranty|american home shield|choice home warranty|first american|frontdoor|select home warranty|warranty company'),
  T('renter', 'Renter: get the landlord or property manager OK', false, 'i rent|we rent|renting|renter|tenant|landlord|property manag\\w*'),
  T('spanish', 'Spanish speaker: call back in Spanish if you can', false, 'spanish|español|espanol|habla\\w*|no hablo'),
  T('existing_customer', 'Existing customer or appointment (Emma cannot see the schedule)', false,
    "existing customer|(?:my|our|the|an|had an) appointment|appointment (?:scheduled|for today|today|this morning|this afternoon)|already (?:scheduled|booked)|running late|(?:hasn'?t|has not|never|didn'?t) (?:shown up|showed up|show up|come|came)|(?:tech|plumber|guy|y'?all|you guys) (?:was|were|came) (?:here|out)|you (?:were|was) (?:just )?(?:here|out)"),
  T('past_job', 'Unhappy about a past job', false, "still (?:leaking|broken|not working)|(?:leaking|broke) again|redo|not happy with|complain\\w*|warranty on (?:the|your) work"),
  T('wants_owner', 'Asked for the owner or a person', false, '(?:talk|speak) (?:to|with) (?:the )?(?:owner|boss|manager|a (?:real )?(?:person|human)|somebody|someone)'),
  T('price_asked', 'Asked about price', false, 'how much|price|pricing|cost|estimate|quote|charge|fee'),
  T('diy_advice', 'Wanted advice to fix it themselves', false, 'tell me how (?:to|i)|how (?:do|can|would) i (?:fix|do|change|replace)|do it myself|fix it myself'),
  T('sales_call', 'Sales or vendor call, not a job', false,
    'marketing|seo|advertis\\w*|google (?:listing|ranking)|merchant services|vendor|supplier|we help (?:plumbers|contractors|businesses)'),
  T('job_seeker', 'Job seeker, not a job', false, 'are you hiring|looking for (?:a job|work)|apply|application|job opening'),
  T('commercial', 'Commercial property', false, 'restaurant|commercial|office building|my store|our store|church|school|apartment complex|grease trap'),
  T('own_parts', 'Caller already has the part or fixture', false, '(?:i|we) (?:already )?(?:have|bought|got|picked up) (?:the|a|my own|our own|a new) (?:part|faucet|toilet|water heater|fixture|disposal)')
];
export const URGENT_TAGS = new Set(TRIGGERS.filter(t => t.urgent).map(t => t.tag));
const LABELS = Object.fromEntries([...TRIGGERS.map(t => [t.tag, t.label]), ['out_of_area', 'Address not in the service area list'],
  ['callback_unconfirmed', 'Callback number was not read back: check it']]);
export const tagLabel = tag => LABELS[tag] || tag;

// "not flooding", "no gas smell", "nothing is frozen": a negation right before the phrase (at most one filler word, same
// clause) cancels it. "No, it's flooding" and "I don't know, the pipe burst" still count.
const NEGATED = /\b(?:no[ -]?one(?:'s)?|nobody(?:'s)?|no|not|never|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|didn'?t|without|nothing|nobody)\s+(?:(?:really|any|a|the|actually|currently|even|is|are|was|been|has|have|had)\s+)?$/;
const sentenceAt = (text, i) => {
  const start = Math.max(...['.', '?', '!'].map(c => text.lastIndexOf(c, i))) + 1;
  const end = text.slice(i).search(/[.?!]/);
  return text.slice(start, end < 0 ? text.length : i + end);
};
export function ruleTags(text) {
  const said = String(text || '').toLowerCase().replace(/[‘’]/g, "'");
  const tags = new Set();
  for (const { tag, re, unless } of TRIGGERS) {
    if (tags.has(tag)) continue;
    for (const match of said.matchAll(new RegExp(re.source, 'g'))) {
      const before = said.slice(Math.max(0, match.index - 40), match.index).split(/[,;:.?!]/).at(-1);
      if (NEGATED.test(before)) continue;
      if (unless && unless.test(sentenceAt(said, match.index))) continue;
      tags.add(tag); break;
    }
  }
  return [...tags];
}

// What the caller has said so far, from a Vapi tool-calls message (artifact.messages, roles 'user'/'customer').
export function callerWords(message = {}) {
  const list = message.artifact?.messages || message.messages || message.call?.artifact?.messages || message.artifact?.messagesOpenAIFormatted || [];
  return Array.isArray(list) ? list.filter(m => m && ['user', 'customer'].includes(m.role))
    .map(m => (typeof m.message === 'string' ? m.message : typeof m.content === 'string' ? m.content : '')).join(' ').slice(0, 20000) : '';
}

// A route's service area: towns or ZIP codes. The address is in the area when it names one of them; with no list, nothing is checked.
export function outOfArea(address, serviceArea) {
  const places = (Array.isArray(serviceArea) ? serviceArea : String(serviceArea || '').split(/[,;\n]/)).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!places.length) return false;
  const words = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const where = ` ${words(String(address || ''))} `;
  return !places.some(p => where.includes(` ${words(p)} `));
}

// After hours, only the shop's "wake" emergencies ring the owner. The default is Jake's "water running now" (2026-10-16): a burst
// or flood, a water heater pouring, water at the electrics, a failed sump. Gas, CO and injuries go to 911; sewage, no water and
// frozen pipes email URGENT at once and wait for the morning. In business hours every
// URGENT job rings, as before. hours: {days: [1..5] (0 = Sunday), start: 7, end: 18, tz: 'America/Chicago'}.
export const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], start: 7, end: 18, tz: 'America/Chicago' };
export const DEFAULT_WAKE = ['active_water', 'water_heater_leak', 'electrical_water', 'sump_failure'];
export function inBusinessHours(now = new Date(), hours = DEFAULT_HOURS) {
  const h = { ...DEFAULT_HOURS, ...(hours && typeof hours === 'object' ? hours : {}) };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: h.tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map(p => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hour = Number(parts.hour);
  return h.days.includes(day) && hour >= h.start && hour < h.end;
}
export function shouldRing(tags = [], route = {}, now = new Date()) {
  if (inBusinessHours(now, route.hours)) return true;
  const wake = Array.isArray(route.wake) ? route.wake : DEFAULT_WAKE;
  // A job Emma marked URGENT that matched no trigger still rings: an unknown emergency is not something to sit on.
  const urgentTags = tags.filter(t => URGENT_TAGS.has(t));
  return !urgentTags.length || urgentTags.some(t => wake.includes(t));
}
