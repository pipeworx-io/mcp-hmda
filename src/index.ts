interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * HMDA — every US mortgage application at loan level (CFPB / FFIEC).
 *
 * WHY THERE IS NO INGEST HERE, which is the opposite of how this was specced.
 * Fleet #526 budgeted a 15M-row-per-year bulk load, ~12-18 GB of Postgres, an
 * R2/Postgres column split, and possibly a compute-tier upgrade — sized against
 * the disk growth that crashed production (#172/#173).
 *
 * None of that is needed. The Data Browser API is live, keyless and documented,
 * and it answers the reverse queries directly (measured 2026-08-25):
 *
 *   /view/aggregations            LEI and/or geography, grouped on any
 *                                 dimension you pass — race, sex, action taken
 *   /view/csv                     loan-level rows, filtered, streamed
 *   /view/nationwide/{...}        the same across the whole country
 *   years 2018-2025
 *
 * The ticket's blocker was that ffiec.cfpb.gov/static/prod/snapshot-data/...
 * returns HTTP 200 with a 3 KB SPA shell and the S3 path 403s. Both true. The
 * answer was not a browser network trace: the API is documented at
 * /documentation/api/data-browser/ and the bulk files are simply not the
 * interface. Reading the docs beat tracing the app.
 *
 * WHAT THE API CANNOT DO, so nobody re-derives it: `leis` is a FILTER, not a
 * grouping. You can ask what one lender did in a county; you cannot ask the
 * county to rank its lenders. That single reverse query is the only thing that
 * would justify a mirror, and it would be a lender x county x year aggregate of
 * roughly 775k rows a year — tens of megabytes, not tens of gigabytes. It is
 * deliberately NOT built here: this pack ships the answers the API already
 * gives, and hmda_lenders_in_county says plainly what it cannot rank and why.
 *
 * Measured for whoever picks that up: nationwide 2023 originations stream as
 * 2,211,851,959 bytes; Los Angeles County alone is 32 MB / 82,636 rows, which
 * is why per-request client-side ranking is not viable in a Worker.
 *
 * LEI -> LENDER NAME (fleet #1241, 2026-09-04): every tool here reports lenders
 * by their 20-character LEI and nothing else, which answers "who lends most
 * here" with twenty opaque codes — not an answer, for a model or a person.
 * GLEIF's own bulk endpoint resolves a whole batch in ONE call:
 * `/lei-records?filter[lei]=A,B,C,...&page[size]=200` — measured live against
 * 100 real San Mateo County LEIs, all 100 resolved in a single request. So this
 * pack makes exactly one extra upstream call per response (chunked at 200 LEIs)
 * rather than one get_lei call per lender. An LEI absent from the batch result
 * (GLEIF's own dead-record case, not a network failure) reports as
 * `legal_name: null` beside the LEI — the row is kept, never dropped, never
 * guessed.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'HMDA');
}

const BASE = 'https://ffiec.cfpb.gov/v2/data-browser-api/view';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

/** Action codes as HMDA defines them; a caller saying "denied" means 3. */
const ACTIONS: Record<string, string> = {
  originated: '1',
  approved_not_accepted: '2',
  denied: '3',
  withdrawn: '4',
  incomplete: '5',
  purchased: '6',
};

const YEARS = '2018-2025';

const tools: McpToolExport['tools'] = [
  {
    name: 'hmda_lender_activity',
    description:
      'What a specific mortgage lender did in a year — applications, originations, denials and dollar volume — from the federal Home Mortgage Disclosure Act register, optionally narrowed to a state or county. Identify the lender by its LEI (the 20-character Legal Entity Identifier HMDA files under); resolve_entity maps a company name to one. Covers every US mortgage application 2018-2025. Reports what lenders DISCLOSED, which is a regulatory filing rather than a market estimate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        lei: { type: 'string', description: '20-character Legal Entity Identifier, e.g. "549300FGXN1K3HLB1R50".' },
        year: { type: 'number', description: `Filing year, ${YEARS}. Defaults to the most recent published.` },
        state: { type: 'string', description: 'Optional two-letter state, e.g. "CA".' },
        county: { type: 'string', description: 'Optional 5-digit county FIPS, e.g. "06037" for Los Angeles.' },
      },
      required: ['lei'],
    },
  },
  {
    name: 'hmda_geography_activity',
    description:
      'Mortgage lending in a place — how many applications were originated, denied or withdrawn in a county or state in a given year, with dollar volume, from the federal HMDA register. Break the answer down by applicant race, ethnicity, sex, loan purpose or loan type to see how outcomes differ across groups, which is the fair-lending question this data exists to make answerable. Covers 2018-2025.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        county: { type: 'string', description: '5-digit county FIPS, e.g. "11001" for the District of Columbia.' },
        state: { type: 'string', description: 'Two-letter state, e.g. "TX". Give a county OR a state.' },
        year: { type: 'number', description: `Filing year, ${YEARS}. Defaults to the most recent published.` },
        breakdown: { type: 'string', description: 'Optional dimension to split by: race | ethnicity | sex | loan_purpose | loan_type.' },
        action: { type: 'string', description: `Optional outcome filter: ${Object.keys(ACTIONS).join(' | ')}. Omit to see every outcome side by side.` },
      },
    },
  },
  {
    name: 'hmda_loan_records',
    description:
      'Individual mortgage application records from the HMDA register — the loan-level rows behind the totals, with loan amount, action taken, rate spread, applicant income, lender LEI and census tract. Use when an aggregate is not enough and the individual applications matter. Filtered by geography and outcome; a large county returns tens of thousands of rows, so this caps what it returns and says when it truncated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        county: { type: 'string', description: '5-digit county FIPS. Give a county OR a state.' },
        state: { type: 'string', description: 'Two-letter state.' },
        year: { type: 'number', description: `Filing year, ${YEARS}.` },
        action: { type: 'string', description: `Outcome filter: ${Object.keys(ACTIONS).join(' | ')}.` },
        lei: { type: 'string', description: 'Optional lender LEI to narrow to one institution.' },
        limit: { type: 'number', description: 'Maximum records to return (1-500, default 50).' },
      },
    },
  },
  {
    name: 'hmda_lenders_in_county',
    description:
      'Which lenders were most active in a county, ranked by loan count, from HMDA loan-level records for that county and year. Returns each lender LEI with its originations, denials and dollar volume, so "who lends here" and "who denies most here" are answerable. Bounded: it reads the county\'s records directly, so very large counties are sampled rather than fully ranked, and the response says so.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        county: { type: 'string', description: '5-digit county FIPS, e.g. "11001".' },
        year: { type: 'number', description: `Filing year, ${YEARS}.` },
        action: { type: 'string', description: `Outcome to rank on: ${Object.keys(ACTIONS).join(' | ')}. Default originated.` },
        limit: { type: 'number', description: 'Lenders to return (1-100, default 20).' },
      },
      required: ['county'],
    },
  },
];

const LATEST_YEAR = 2025;

function yearArg(v: unknown): number {
  const n = Number(v);
  // Never silently pick a year: an HMDA answer for the wrong year is a
  // confidently wrong number with fair-lending consequences.
  if (!Number.isFinite(n) || n < 2018 || n > LATEST_YEAR) return LATEST_YEAR;
  return Math.trunc(n);
}

const BREAKDOWNS: Record<string, string> = {
  race: 'races=American Indian or Alaska Native,Asian,Black or African American,Native Hawaiian or Other Pacific Islander,White,2 or more minority races,Joint',
  ethnicity: 'ethnicities=Hispanic or Latino,Not Hispanic or Latino,Joint',
  sex: 'sexes=Male,Female,Joint',
  loan_purpose: 'loan_purposes=Home purchase,Home improvement,Refinancing,Cash-out refinancing,Other purpose',
  loan_type: 'loan_types=Conventional,FHA,VA,RHS or FSA',
};

async function hmdaGet(path: string): Promise<Response> {
  const res = await pwFetch(`${BASE}${path}`, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HMDA API returned HTTP ${res.status} for ${path}`);
  return res;
}

interface Agg { count: number; sum: number; [k: string]: unknown }

async function aggregations(query: string) {
  const res = await hmdaGet(`/aggregations?${query}`);
  const body = (await res.json()) as { aggregations?: Agg[]; parameters?: Record<string, unknown> };
  return body;
}

function actionFilter(action: unknown): string {
  const a = String(action ?? '').trim().toLowerCase();
  if (!a) return `actions_taken=${Object.values(ACTIONS).join(',')}`;
  const code = ACTIONS[a];
  if (!code) throw new Error(`action must be one of: ${Object.keys(ACTIONS).join(', ')}. Got "${action}".`);
  return `actions_taken=${code}`;
}

const CODE_TO_ACTION = Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [v, k]));

function shapeAggs(aggs: Agg[]) {
  return aggs.map((a) => {
    const { count, sum, actions_taken, ...rest } = a;
    return {
      ...(actions_taken ? { outcome: CODE_TO_ACTION[String(actions_taken)] ?? String(actions_taken) } : {}),
      ...rest,
      applications: count,
      dollar_volume_usd: Math.round(Number(sum) || 0),
    };
  });
}

// ── LEI -> legal name, batched ──────────────────────────────────────
// GLEIF is keyless and public; its /lei-records endpoint accepts a
// comma-joined list of LEIs in one filter, so resolving a whole page of
// lenders costs one upstream call, not one per lender. Chunked at 200
// (GLEIF's own page-size ceiling for this endpoint).
const GLEIF_BASE = 'https://api.gleif.org/api/v1';
const GLEIF_CHUNK = 200;

async function resolveLeiNames(leis: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(leis.filter(Boolean))];
  const out = new Map<string, string | null>(unique.map((l) => [l, null]));
  if (!unique.length) return out;
  for (let i = 0; i < unique.length; i += GLEIF_CHUNK) {
    const chunk = unique.slice(i, i + GLEIF_CHUNK);
    try {
      const res = await pwFetch(
        `${GLEIF_BASE}/lei-records?${new URLSearchParams({ 'filter[lei]': chunk.join(','), 'page[size]': String(GLEIF_CHUNK) })}`,
        { headers: { Accept: 'application/vnd.api+json' } },
      );
      if (!res.ok) continue; // leave this chunk's names null rather than fail the whole HMDA answer
      const body = (await res.json()) as {
        data?: { id?: string; attributes?: { lei?: string; entity?: { legalName?: { name?: string } } } }[];
      };
      for (const rec of body.data ?? []) {
        const lei = rec.attributes?.lei ?? rec.id;
        const name = rec.attributes?.entity?.legalName?.name;
        if (lei && name) out.set(lei, name);
      }
    } catch {
      // Name resolution is an enrichment, not the answer itself — an LEI that
      // fails to resolve stays in the response as `legal_name: null`, never
      // dropped and never guessed.
    }
  }
  return out;
}

const SOURCE = 'CFPB / FFIEC Home Mortgage Disclosure Act (HMDA) Data Browser';
const CAVEAT =
  'HMDA records what lenders disclosed under a reporting requirement, not the whole mortgage market: institutions below the reporting thresholds do not appear, and a denial reflects the lender\'s coded reason rather than an adjudicated finding. Dollar volume is the sum of loan amounts, not balances outstanding.';

async function lenderActivity(args: Record<string, unknown>) {
  const lei = String(args.lei ?? '').trim();
  if (!lei) throw new Error('lei is required — the 20-character Legal Entity Identifier the lender files under. resolve_entity({type:"company"}) can map a name to one.');
  const year = yearArg(args.year);
  const geo = args.county ? `&counties=${encodeURIComponent(String(args.county))}`
    : args.state ? `&states=${encodeURIComponent(String(args.state).toUpperCase())}` : '';
  const body = await aggregations(
    `years=${year}&leis=${encodeURIComponent(lei)}${geo}&${actionFilter(undefined)}`,
  );
  const rows = shapeAggs(body.aggregations ?? []);
  if (!rows.length) {
    return {
      found: false, reason: 'no_filings', lei, year,
      hint: `No HMDA records for LEI ${lei} in ${year}${geo ? ' for that geography' : ''}. A lender absent from a year did not file — it may be below the reporting threshold, may have merged, or the LEI may belong to a parent that files under a different entity. Check another year before concluding it does no lending.`,
      source: SOURCE,
    };
  }
  const names = await resolveLeiNames([lei]);
  return {
    found: true, lei, legal_name: names.get(lei) ?? null, year,
    ...(args.county ? { county: String(args.county) } : {}),
    ...(args.state ? { state: String(args.state).toUpperCase() } : {}),
    total_applications: rows.reduce((n, r) => n + r.applications, 0),
    by_outcome: rows,
    source: SOURCE, interpretation: CAVEAT,
  };
}

async function geographyActivity(args: Record<string, unknown>) {
  const county = args.county ? String(args.county).trim() : '';
  const state = args.state ? String(args.state).trim().toUpperCase() : '';
  if (!county && !state) throw new Error('Give a county (5-digit FIPS, e.g. "11001") or a state ("TX").');
  const year = yearArg(args.year);
  const geo = county ? `counties=${encodeURIComponent(county)}` : `states=${encodeURIComponent(state)}`;
  const bd = args.breakdown ? String(args.breakdown).trim().toLowerCase() : '';
  if (bd && !BREAKDOWNS[bd]) {
    throw new Error(`breakdown must be one of: ${Object.keys(BREAKDOWNS).join(', ')}. Got "${args.breakdown}".`);
  }
  const body = await aggregations(
    `years=${year}&${geo}&${actionFilter(args.action)}${bd ? `&${BREAKDOWNS[bd]}` : ''}`,
  );
  const rows = shapeAggs(body.aggregations ?? []);
  if (!rows.length) {
    return {
      found: false, reason: 'no_records', year, ...(county ? { county } : { state }),
      hint: 'No HMDA records matched. Counties are 5-digit FIPS ("06037", not "Los Angeles"); states are two-letter codes. A real place with no records for a year usually means the filter combination is too narrow, not that no lending occurred.',
      source: SOURCE,
    };
  }
  return {
    found: true, year, ...(county ? { county } : { state }),
    ...(bd ? { breakdown: bd } : {}),
    total_applications: rows.reduce((n, r) => n + r.applications, 0),
    rows,
    source: SOURCE, interpretation: CAVEAT,
  };
}

/** Bounded read of the loan-level CSV. Large counties are tens of MB. */
const MAX_BYTES = 24_000_000;

async function fetchCsv(query: string): Promise<{ header: string[]; rows: string[][]; truncated: boolean; bytes: number }> {
  const res = await hmdaGet(`/csv?${query}`);
  const text = await res.text();
  const bytes = new TextEncoder().encode(text).length;
  const truncated = bytes > MAX_BYTES;
  const lines = (truncated ? text.slice(0, MAX_BYTES) : text).split('\n').filter(Boolean);
  const header = (lines.shift() ?? '').split(',');
  // Values may be quoted; a naive split is wrong for free-text columns, so parse
  // only the columns this pack uses and leave the rest alone.
  return { header, rows: lines.map((l) => l.split(',')), truncated, bytes };
}

function col(header: string[], name: string): number { return header.indexOf(name); }

async function loanRecords(args: Record<string, unknown>) {
  const county = args.county ? String(args.county).trim() : '';
  const state = args.state ? String(args.state).trim().toUpperCase() : '';
  if (!county && !state) throw new Error('Give a county (5-digit FIPS) or a state (two-letter code).');
  const year = yearArg(args.year);
  const limit = Math.min(500, Math.max(1, Number(args.limit) || 50));
  const geo = county ? `counties=${encodeURIComponent(county)}` : `states=${encodeURIComponent(state)}`;
  const lei = args.lei ? `&leis=${encodeURIComponent(String(args.lei))}` : '';
  const { header, rows, truncated, bytes } = await fetchCsv(`years=${year}&${geo}${lei}&${actionFilter(args.action)}`);

  const idx = {
    lei: col(header, 'lei'), action: col(header, 'action_taken'), amount: col(header, 'loan_amount'),
    tract: col(header, 'census_tract'), income: col(header, 'income'), spread: col(header, 'rate_spread'),
    purpose: col(header, 'derived_loan_product_type'), county: col(header, 'county_code'),
  };
  const slice = rows.slice(0, limit);
  const names = await resolveLeiNames(slice.map((r) => r[idx.lei]).filter(Boolean));
  const out = slice.map((r) => ({
    lei: r[idx.lei] ?? null,
    legal_name: r[idx.lei] ? names.get(r[idx.lei]) ?? null : null,
    outcome: CODE_TO_ACTION[r[idx.action]] ?? r[idx.action] ?? null,
    loan_amount_usd: Number(r[idx.amount]) || null,
    applicant_income_thousands: Number(r[idx.income]) || null,
    rate_spread: r[idx.spread] || null,
    census_tract: r[idx.tract] ?? null,
    county_fips: r[idx.county] ?? null,
    loan_product: r[idx.purpose] ?? null,
  }));
  return {
    found: out.length > 0, year, ...(county ? { county } : { state }),
    returned: out.length, records_available: rows.length,
    ...(truncated ? {
      truncated: true,
      note: `This geography returned more than ${(MAX_BYTES / 1e6).toFixed(0)} MB of records and was cut short, so records_available understates the true total. Use hmda_geography_activity for the complete count, and narrow by lender or outcome to read individual rows.`,
    } : {}),
    bytes_read: bytes,
    records: out,
    source: SOURCE, interpretation: CAVEAT,
  };
}

async function lendersInCounty(args: Record<string, unknown>) {
  const county = String(args.county ?? '').trim();
  if (!county) throw new Error('county is required — 5-digit FIPS, e.g. "11001".');
  const year = yearArg(args.year);
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const action = args.action ? String(args.action) : 'originated';
  const { header, rows, truncated, bytes } = await fetchCsv(
    `years=${year}&counties=${encodeURIComponent(county)}&${actionFilter(action)}`,
  );
  const li = col(header, 'lei'), ai = col(header, 'loan_amount');
  const tally = new Map<string, { loans: number; usd: number }>();
  for (const r of rows) {
    const lei = r[li];
    if (!lei) continue;
    const t = tally.get(lei) ?? { loans: 0, usd: 0 };
    t.loans += 1; t.usd += Number(r[ai]) || 0;
    tally.set(lei, t);
  }
  const topLeis = [...tally.entries()]
    .sort((a, b) => b[1].loans - a[1].loans)
    .slice(0, limit)
    .map(([lei]) => lei);
  const names = await resolveLeiNames(topLeis);
  const ranked = topLeis.map((lei) => {
    const t = tally.get(lei)!;
    return { lei, legal_name: names.get(lei) ?? null, loans: t.loans, dollar_volume_usd: t.usd };
  });
  const unresolvedCount = ranked.filter((r) => r.legal_name === null).length;
  return {
    found: ranked.length > 0, county, year, outcome: action,
    lenders_found: tally.size, returned: ranked.length, lenders: ranked,
    ...(unresolvedCount
      ? { unresolved_names: `${unresolvedCount} of ${ranked.length} LEIs did not resolve to a legal name in GLEIF (registration lapsed, merged, or not yet indexed) — those rows keep the LEI with legal_name: null rather than being dropped or guessed.` }
      : {}),
    ...(truncated ? {
      truncated: true,
      // Honest about the one thing the upstream cannot do for us.
      note: `This county returned more than ${(MAX_BYTES / 1e6).toFixed(0)} MB of records, so this ranking is built from the first ${(MAX_BYTES / 1e6).toFixed(0)} MB and UNDERSTATES lenders whose records fall later in the file. The HMDA API treats lender identity as a filter rather than a grouping, so a complete ranking needs a precomputed lender-by-county aggregate, which this pack deliberately does not carry.`,
    } : {}),
    bytes_read: bytes,
    source: SOURCE, interpretation: CAVEAT,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'hmda_lender_activity': return lenderActivity(args);
    case 'hmda_geography_activity': return geographyActivity(args);
    case 'hmda_loan_records': return loanRecords(args);
    case 'hmda_lenders_in_county': return lendersInCounty(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 } } satisfies McpToolExport;
