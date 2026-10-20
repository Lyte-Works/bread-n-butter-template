'use strict';

// IS: THE single definition of the file-side memory hash / tag / anchor
//     primitives — contentHash, inferTags, parseFrontmatter, resolveTags, the
//     anchor grammar (ANCHOR_CAP, ANCHOR_STOP, ANCHOR_KEYWORDS, ANCHOR_PROSE,
//     isAnchorToken, mineAnchors), and resolveTouches. One consumer:
//       - scripts/keeper-sync.cjs require()s it lazily, as a sibling.
//     It travels with keeper-sync.cjs: the template carries both.
// IS NOT: the unit producer (keeper-sync.cjs inferLessonMeta composes
//     inferTags + mineAnchors but its applies_during / applies_when heuristics
//     are keeper-only), nor anything that touches a DB.

var crypto = require('crypto');

// sha256 of a unit's content — the cross-path dedup key: `memories` insert
// dedup AND the `embeddings.content_hash` key. Divergence across write paths
// would mean brokered rows stop deduping against direct rows.
function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Keyword tag inference over the first 1000 chars — the fallback when a unit
// carries no curated frontmatter tags. Brokered and direct rows must tag
// identically or recall ranking differs by write path.
function inferTags(content) {
  var lower = content.slice(0, 1000).toLowerCase();
  var tags = [];
  if (lower.includes('css') || lower.includes('style') || lower.includes('tailwind')) tags.push('css');
  if (lower.includes('responsive') || lower.includes('mobile') || lower.includes('breakpoint')) tags.push('responsive');
  if (lower.includes('api') || lower.includes('fetch') || lower.includes('endpoint')) tags.push('api');
  if (lower.includes('component') || lower.includes('react') || lower.includes('next')) tags.push('components');
  if (lower.includes('deploy') || lower.includes('vercel') || lower.includes('ci/cd')) tags.push('deploy');
  if (lower.includes('security') || lower.includes('auth') || lower.includes('rls')) tags.push('security');
  if (lower.includes('database') || lower.includes('supabase') || lower.includes('migration') || lower.includes('sql')) tags.push('data');
  if (lower.includes('test') || lower.includes('spec') || lower.includes('assert')) tags.push('testing');
  if (lower.includes('git') || lower.includes('branch') || lower.includes('commit')) tags.push('git');
  if (lower.includes('worker') || lower.includes('agent') || lower.includes('boot')) tags.push('framework');
  return tags;
}

// Parse YAML frontmatter from a markdown file
function parseFrontmatter(content) {
  var match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { frontmatter: null, body: content };

  var yaml = match[1];
  var body = content.slice(match[0].length);
  var fm = {};

  // Simple YAML parser for our subset (key: value, key: [array])
  var lines = yaml.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    var kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    var key = kv[1];
    var val = kv[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val.slice(1, -1).split(',').map(function(s) { return s.trim().replace(/^['"]|['"]$/g, ''); }).filter(Boolean);
    } else {
      fm[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return { frontmatter: fm, body: body };
}

// Resolve the tags a unit carries in `memories.tags` — the ONLY field recall
// matches on (activate.ts `.overlaps("tags", tags)`). Curated frontmatter tags
// are AUTHORITATIVE when present (the Keeper hand-edits them); keyword
// inference is only the fallback for units with none (knowledge observations,
// un-curated lessons) — so hand-curated tags actually reach recall instead of
// being overwritten by inference on every sync.
function resolveTags(content) {
  var parsed = parseFrontmatter(content);
  var fmTags = parsed.frontmatter && parsed.frontmatter.tags;
  if (Array.isArray(fmTags) && fmTags.length > 0) return fmTags;
  return inferTags(content);
}

// ── Artifact-anchored recall — the anchor grammar (design 531c84d7 §5). Both
// the write side (SYNC / reconcile populate `memories.touches`) AND the
// keyed-recall query (activate.ts) normalize through mineAnchors, so an anchor
// mined on write matches an anchor mined from a prompt.

var ANCHOR_CAP = 24; // bounds a giant lesson from bloating touches[] (§5.1).

// SCREAMING tokens that are common English/protocol words, not identifiers
// (§5.1). Used only in the const pass to keep HTTP_PROXY-style false positives
// explicit — the SCREAMING_SNAKE gate already requires an underscore, so a bare
// JSON/NULL never matches there.
var ANCHOR_STOP = new Set([
  'TODO', 'NOTE', 'FIXME', 'XXX', 'WARN', 'WARNING', 'HTTP', 'HTTPS',
  'JSON', 'HTML', 'NULL', 'TRUE', 'FALSE', 'YAML',
]);

// JS/TS keyword + reserved-word backstop for the inline-backtick pass (§5.1),
// checked per dot-segment so a dotted form (`this.foo`, `new.target`) is rejected
// on its keyword segment even though its shape looks deliberate.
var ANCHOR_KEYWORDS = new Set([
  'await', 'async', 'const', 'let', 'var', 'function', 'return', 'import',
  'export', 'default', 'class', 'extends', 'super', 'this', 'new', 'typeof',
  'instanceof', 'void', 'delete', 'yield', 'true', 'false', 'null', 'undefined',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'throw',
  'try', 'catch', 'finally', 'do', 'in', 'of', 'with', 'debugger', 'static',
  'get', 'set',
]);

// SMALL common-English / prose / stdlib-global stop-list for the inline-backtick
// pass (§5.1). A backtick-wrapped PLAIN-lowercase token is a DELIBERATE authorial
// reference — DB tables/columns (`memories`, `knowledge`, `documents`, `fields`,
// `lanes`, `messages`) are overwhelmingly plain-lowercase and are a CORE anchor
// class, so they are KEPT. This denylist only removes the common English/prose
// words and stdlib globals authors backtick out of habit (`status`, `build`,
// `map`, `all`, `via`, `app`, …). A denylist is unavoidable here: DB names and
// prose words share the same plain-lowercase shape, so only a curated list — not
// a shape gate — can separate them without gutting the DB-object anchor class.
var ANCHOR_PROSE = new Set([
  'and', 'any', 'all', 'app', 'are', 'was', 'were', 'the', 'then', 'this',
  'that', 'these', 'those', 'with', 'for', 'from', 'into', 'use', 'used',
  'uses', 'via', 'when', 'map', 'run', 'ran', 'not', 'can', 'may', 'build',
  'status', 'right', 'slow', 'component', 'endpoint', 'thing', 'done',
]);

// A backtick token earns an anchor unless it is noise (§5.1, precision-first).
// KEEP when its SHAPE marks it a deliberate identifier — camelCase/internal-Pascal
// (`invokePrismHandler`, `PrismHandler`), snake_case (`match_memory`), or dotted
// member access (`memories.touches`). Otherwise it is a PLAIN single word: reject
// Uppercase-leading singles (single-word Pascal / ALLCAPS like `Promise`,
// `Object`, `MUST`) and common prose/keyword words; a surviving plain-lowercase
// word is a deliberate DB-object reference (`memories`, `knowledge`) and is kept.
// A JS/TS keyword segment is always rejected as a backstop.
function isAnchorToken(tok) {
  if (tok.length < 3) return false;
  var segs = tok.split('.');
  for (var s = 0; s < segs.length; s++) {
    if (ANCHOR_KEYWORDS.has(segs[s])) return false;
  }
  // Deliberate SHAPE → always an anchor (camelCase, snake_case, dotted member).
  if (/[a-z][A-Z]/.test(tok) || tok.indexOf('_') !== -1 || tok.indexOf('.') !== -1) {
    return true;
  }
  // Plain single word: reject Uppercase-leading (single-word Pascal / ALLCAPS)
  // and common prose/stdlib words; keep plain-lowercase DB-object names.
  if (/[A-Z]/.test(tok.charAt(0))) return false;
  if (ANCHOR_PROSE.has(tok)) return false;
  return true;
}

// Deterministic, no-AI artifact-anchor miner. Extracts the exact identifiers a
// memory unit concerns and stores PATHS multi-grain (full+basename+stem) so any
// grain of a later query overlaps; symbols/consts are stored case-preserved ONCE
// (case-insensitive matching is the recall query's job, not a stored dupe).
// Precision-first: multi-line code fences are examples, NOT artifact references,
// so their interior is never mined; inline-backtick words count when their SHAPE
// marks them a deliberate identifier OR they are a plain-lowercase DB-object name
// not on the prose stop-list; path/route/SCREAMING tokens are self-disambiguating
// and count anywhere. Passes run highest-precision first.
function mineAnchors(content) {
  if (!content) return [];
  var out = [];
  var seen = new Set();
  function add(a) {
    if (!a || out.length >= ANCHOR_CAP || seen.has(a)) return;
    seen.add(a);
    out.push(a);
  }
  function addPath(p) {
    add(p);
    var base = p.split('/').pop();
    if (base && base !== p) add(base);
    var dot = base.lastIndexOf('.');
    if (dot > 0) add(base.slice(0, dot));
  }

  var m;

  // Pass 1 — file paths (self-disambiguating, anywhere).
  var pathRe = /[\w./[\]-]+\.(?:ts|tsx|cjs|js|mjs|sql|md|json)\b/g;
  while ((m = pathRe.exec(content)) !== null) addPath(m[0]);

  // Pass 2 — /api routes (self-disambiguating, anywhere).
  var routeRe = /\/api\/[\w/[\]{}:.-]+/g;
  while ((m = routeRe.exec(content)) !== null) add(m[0].replace(/\/+$/, ''));

  // Pass 3 — SCREAMING_SNAKE consts / env vars (underscore required; skip the
  // common-word stop-list). Stored case-preserved once.
  var screamRe = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
  while ((m = screamRe.exec(content)) !== null) {
    if (!ANCHOR_STOP.has(m[0])) add(m[0]);
  }

  // Pass 4 — anchor tokens inside INLINE backticks only (isAnchorToken).
  // Multi-line ```code fences``` are illustrative examples, not artifact
  // references, so they are stripped ENTIRELY (never mined) — a camelCase name
  // that appears only inside a fence must not leak into anchors (§5.1).
  var noFences = content.replace(/```[\s\S]*?```/g, ' ');
  var spans = [];
  var inlineRe = /`([^`\n]+)`/g;
  while ((m = inlineRe.exec(noFences)) !== null) spans.push(m[1]);
  // Capture identifier runs that may carry interior dots (member access); the
  // anchor gate then keeps deliberate identifiers + plain-lowercase DB objects.
  var identRe = /[A-Za-z_][A-Za-z0-9_.]*[A-Za-z0-9_]|[A-Za-z_]/g;
  for (var i = 0; i < spans.length; i++) {
    // Strip path/route substrings first — pass 1/2 already anchored them
    // multi-grain; re-tokenizing `src/lib/x.ts` into src/lib/x/ts is pure noise.
    var bare = spans[i].replace(pathRe, ' ').replace(routeRe, ' ');
    identRe.lastIndex = 0;
    var t;
    while ((t = identRe.exec(bare)) !== null) {
      var tok = t[0];
      if (!isAnchorToken(tok)) continue;
      add(tok);
    }
  }

  return out;
}

// Resolve the anchors a unit carries in `memories.touches` — curated
// frontmatter `touches:` wins when present (mirror of resolveTags'
// precedence); mineAnchors is the fallback for units with none.
function resolveTouches(content) {
  var parsed = parseFrontmatter(content);
  var fmTouches = parsed.frontmatter && parsed.frontmatter.touches;
  if (Array.isArray(fmTouches) && fmTouches.length > 0) return fmTouches;
  return mineAnchors(content);
}
module.exports = {
  contentHash: contentHash,
  inferTags: inferTags,
  parseFrontmatter: parseFrontmatter,
  resolveTags: resolveTags,
  ANCHOR_CAP: ANCHOR_CAP,
  ANCHOR_STOP: ANCHOR_STOP,
  ANCHOR_KEYWORDS: ANCHOR_KEYWORDS,
  ANCHOR_PROSE: ANCHOR_PROSE,
  isAnchorToken: isAnchorToken,
  mineAnchors: mineAnchors,
  resolveTouches: resolveTouches,
};
