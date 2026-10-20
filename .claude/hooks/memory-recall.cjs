#!/usr/bin/env node
'use strict';
// IS: The UserPromptSubmit hook — LOCAL lesson retrieval read LIVE from the
//     field's own repo files. Answers ONE question: "given this prompt, which
//     already-curated lessons should ride along?" Scans
//     `.lyte/memory/<worker>/lessons/*.md` at prompt time, builds the BM25
//     corpus in memory from each lesson's TRIGGER SURFACE (title, description,
//     triggers, applies_when, applies_during, tags), scores every lesson
//     against the prompt, and prints a ready-to-inject markdown block — or
//     nothing. Whatever a UserPromptSubmit hook prints is appended to the
//     prompt's context. Its one WRITE: an append-only line per injection to
//     .lyte/memory/recall-log.jsonl, which is how anything knows which lessons
//     recall injected (2026-10-07).
// IS NOT: A memory writer — the Keeper curates the lesson files; keeper-sync
//     step 7 reads the log and writes .lyte/memory/recall-report.md. Exit 0
//     always — recall is a nudge, never a wedge.
//
// Bread 'n' Butter's copy. The pure functions stay exported for tests.
//
// WHAT THE LOG MAY CARRY. The prompt text never leaves this process: the line
// holds a truncated SHA-256 of the prompt's FIRST 80 CHARACTERS and nothing
// else from it — enough to tell two injections on the same prompt apart, not
// enough to read the prompt back. The file is per-checkout telemetry and is
// gitignored; the committed artifact is the report keeper-sync derives.

// WHY LIVE, NOT INDEXED
// Until 2026-09-22 this scored against `.lyte/memory/recall-index.json`, a
// generated BM25 index each field's keeper-sync rebuilt. That bought nothing:
// the corpus is dozens of small markdown files, so building it costs
// milliseconds — while the index cost a generator, a build/query tokenizer
// contract that could skew, a version field to survive the skew, and a file
// that was stale between the Keeper's write and the next sync run. Reading the
// lessons themselves removes all four: nothing to generate, nothing to keep
// fresh, nothing that can disagree with what the Keeper just wrote.
//
// Inputs (recall):
//   { prompt, transcriptPath, repoRoot }
//     prompt         — the user's prompt text to match against.
//     transcriptPath — optional session transcript (JSONL); used only to
//                      DEDUP lessons already injected this session.
//                      Unreadable → dedup is skipped, recall still works.
//     repoRoot       — the field repo root; `.lyte/memory` resolves under it.
// Output:
//   A markdown block ('## Field lessons (auto-recalled)' + up to 3 lesson
//   pointers, inside a ~1200-character budget) or '' when nothing clears the
//   silence gate.
//
// THE TRIGGER SURFACE is the whole corpus — lesson BODIES are deliberately
// excluded. They used to be indexed, and at ~350 of every ~400 tokens they
// diluted the curated fields about 6:1, so the corpus scored "which lesson
// talks about these words the most" instead of "which lesson APPLIES here":
// a prompt citing a github.com URL pulled a GitHub-token-rotation lesson, one
// about semantic search pulled the OAuth Connections lesson. The Keeper
// already curates exactly the surface retrieval needs.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MEMORY_REL = path.join('.lyte', 'memory');

// BM25 parameters (Okapi defaults).
const K1 = 1.2;
const B = 0.75;

// The silence gate. Every pick must clear SCORE_FLOOR on its OWN and match at
// least MIN_MATCHED_TERMS distinct query terms — a single-term coincidence
// stays silent, and one strong match never drags in weak company.
// Calibrated against a live lesson corpus: prompts that should stay silent
// top out around 12, prompts that should fire bottom out around 24. 18 sits in
// the middle of that gap rather than hugging either edge.
const SCORE_FLOOR = 18;
// Half the top score. Companions are gated by the ratio, silence by the floor,
// so loosening this cannot make a should-be-silent prompt speak — it only
// decides how much company a genuine hit brings. At 0.55 a 403-token prompt
// dropped the mint-side twin its own top hit cross-references, by 0.1.
const RELATIVE_FLOOR = 0.5;
const MIN_MATCHED_TERMS = 2;
const MAX_LESSONS = 3;
// A pointer block costs characters, not lines — cap what it costs.
const MAX_CHARS = 1200;
// Triggers are the single most deliberate signal the Keeper writes — the
// author naming when the lesson should fire. Weight them above the rest.
const TRIGGER_WEIGHT = 3;

// Silence, in the shape recallDetailed returns. Frozen so no caller can turn
// one no-op into a shared mutable.
const EMPTY = Object.freeze({ block: '', picked: Object.freeze([]) });

// Common English stopwords (only tokens >= 3 chars matter — shorter ones are
// already dropped by the length rule).
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her',
  'was', 'one', 'our', 'out', 'has', 'had', 'have', 'his', 'him', 'she',
  'this', 'that', 'these', 'those', 'with', 'from', 'they', 'them', 'then',
  'than', 'their', 'there', 'here', 'what', 'when', 'where', 'which', 'who',
  'whom', 'why', 'how', 'its', 'your', 'yours', 'were', 'will', 'would',
  'could', 'should', 'shall', 'may', 'might', 'must', 'been', 'being',
  'does', 'did', 'doing', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'only', 'own', 'same', 'too', 'very', 'just', 'about', 'into',
  'over', 'under', 'again', 'once', 'both', 'during', 'before', 'after',
  'above', 'below', 'between', 'through', 'until', 'while', 'any', 'also',
  'because', 'against',
  // Conversational filler — never a topic, and common in the prompts recall
  // sees ("what do you think", "how would you make this better").
  'think', 'thinks', 'thought', 'feel', 'feels', 'though', 'want', 'wants',
  'need', 'needs', 'know', 'knows', 'like', 'likes', 'make', 'makes', 'made',
  'better', 'best', 'explain', 'tell', 'show', 'give', 'look', 'looks',
  'thing', 'things', 'stuff', 'really', 'maybe', 'lot', 'lots', 'way', 'ways',
  'going', 'get', 'gets', 'use', 'uses', 'used', 'add', 'adds', 'anything',
  // File-format and web noise — addressing, not subject matter.
  'http', 'https', 'www', 'com', 'org', 'net', 'html', 'json', 'cjs',
  'tsx', 'png', 'jpg', 'svg', 'url', 'href',
]);

// One tokenizer, used for BOTH the prompt and the lesson surface. When those
// two were separate functions in separate files they could skew; now they
// cannot.
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    // A URL is ADDRESSING, not topic. Left in, its parts ('http', 'com', the
    // repo owner) become rare high-idf query terms that outscore every real
    // word in the prompt. Code spans are deliberately NOT stripped — an
    // identifier in backticks is usually the subject, not the address.
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    // Naive plural fold so "form" finds "forms".
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

// The frontmatter subset lesson files carry: `key: value` and `key: [a, b]`.
// Deliberately the same shape keeper-sync.cjs parses — lesson files are
// written for both readers.
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { frontmatter: {}, body: content };
  const fm = {};
  for (const line of match[1].split('\n')) {
    const kv = line.trim().match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const val = kv[2].trim();
    fm[kv[1]] = val.startsWith('[') && val.endsWith(']')
      ? val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      : val.replace(/^['"]|['"]$/g, '');
  }
  return { frontmatter: fm, body: content.slice(match[0].length) };
}

// A frontmatter value may be a bracket-array or a plain scalar.
function fmText(value) {
  if (!value) return '';
  return Array.isArray(value) ? value.join(' ') : String(value);
}

// One lesson file → the scored document: its trigger-surface term frequencies,
// plus the title and description the pointer renders from.
function lessonDoc(content, slug, worker) {
  const { frontmatter: fm, body } = parseFrontmatter(content);

  let title = fm.title;
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    title = h1 ? h1[1].trim() : slug;
  }
  const desc = fm.description ? String(fm.description).trim() : '';
  // The lesson's operative rule, one or two sentences (2026-10-15). What recall
  // injects when present, so the model acts on the rule without a second Read;
  // the description stays the trigger surface either way.
  const rule = fm.rule ? String(fm.rule).trim() : '';

  let tokens = tokenize(title).concat(tokenize(desc));
  const triggers = tokenize(fmText(fm.triggers));
  for (let r = 0; r < TRIGGER_WEIGHT; r++) tokens = tokens.concat(triggers);
  tokens = tokens
    .concat(tokenize(fmText(fm.applies_when)))
    .concat(tokenize(fmText(fm.applies_during)))
    .concat(tokenize(fmText(fm.tags)));

  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;

  return {
    worker,
    slug,
    path: '.lyte/memory/' + worker + '/lessons/' + slug + '.md',
    title,
    desc,
    rule,
    len: tokens.length,
    tf,
  };
}

// Every lesson in the repo, read fresh. A worker directory with no `lessons/`
// contributes nothing; an unreadable file is skipped rather than fatal — one
// bad file must not silence the whole corpus.
function scanLessons(repoRoot) {
  const memoryRoot = path.join(repoRoot, MEMORY_REL);
  let workers;
  try {
    workers = fs.readdirSync(memoryRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // no .lyte/memory — a repo with no worker memory yet
  }

  const docs = [];
  for (const worker of workers) {
    const lessonsDir = path.join(memoryRoot, worker, 'lessons');
    let files;
    try {
      files = fs.readdirSync(lessonsDir).filter((f) => f.endsWith('.md'));
    } catch {
      continue; // this worker has no lessons/ directory
    }
    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(path.join(lessonsDir, file), 'utf8');
      } catch {
        continue;
      }
      docs.push(lessonDoc(content, file.slice(0, -3), worker));
    }
  }
  return docs;
}

// Corpus statistics BM25 needs: document frequency per term, document count,
// average document length.
function buildCorpus(docs) {
  const df = {};
  let totalLen = 0;
  for (const doc of docs) {
    totalLen += doc.len;
    for (const term of Object.keys(doc.tf)) df[term] = (df[term] || 0) + 1;
  }
  return { df, N: docs.length, avgLen: docs.length ? totalLen / docs.length : 0 };
}

// Okapi BM25. Returns { score, matched } where matched counts DISTINCT query
// terms present in the lesson's trigger surface.
function scoreLesson(queryTerms, doc, corpus) {
  let score = 0;
  let matched = 0;
  const len = doc.len > 0 ? doc.len : corpus.avgLen;
  for (const t of queryTerms) {
    const tf = doc.tf[t];
    if (!tf) continue;
    matched++;
    const df = corpus.df[t] || 1;
    // +0.35 smoothing: classic BM25 idf collapses toward 0 when N is small
    // (a young field with 1-3 lessons scored ~0.29/term and could never clear
    // the floor). The constant keeps small-corpus matches scoreable without
    // letting ubiquitous terms dominate large corpora.
    const idf = Math.log((corpus.N - df + 0.5) / (df + 0.5) + 1) + 0.35;
    const denom = tf + K1 * (1 - B + (B * len) / corpus.avgLen);
    score += idf * ((tf * (K1 + 1)) / denom);
  }
  return { score, matched };
}

// Has this lesson already surfaced this session? The rendered
// `### <title> (<worker>)` heading in the transcript is the reliable marker —
// a bare mention of the lesson's PATH is not, because the scan cannot tell a
// deliberate Read from an `ls` or a grep of the lessons directory.
function alreadySeen(transcriptRaw, doc) {
  if (!transcriptRaw) return false;
  return transcriptRaw.indexOf('### ' + doc.title + ' (' + doc.worker + ')') !== -1;
}

// The curated description plus a path, never the body. The agent decides from
// the trigger whether the lesson is worth reading — which is the judgement a
// prompt-time keyword match cannot make.
function render(picked) {
  const out = ['## Field lessons (auto-recalled)', ''];
  let chars = 0;
  for (const doc of picked) {
    // A lesson with a `rule:` is injected AS the rule, its file named for the
    // story behind it; one without falls back to its description and a pointer.
    const block = doc.rule
      ? ['### ' + doc.title + ' (' + doc.worker + ')', doc.rule, '↳ `' + doc.path + '`', '']
      : ['### ' + doc.title + ' (' + doc.worker + ')']
        .concat(doc.desc ? [doc.desc] : [])
        .concat(['→ read `' + doc.path + '` if that trigger fits.', '']);
    const size = block.join('\n').length;
    // The budget trims companions, never the top pick — one long description
    // must not turn a genuine hit into silence.
    if (out.length > 2 && chars + size > MAX_CHARS) break;
    chars += size;
    out.push(...block);
  }
  if (out.length <= 2) return '';
  out.push("*From this field's memory — apply a rule when its situation is yours; open the file only for the story behind it.*");
  return out.join('\n') + '\n';
}

// The whole decision, with its picks and their scores exposed. Still PURE over
// local files — it writes nothing. The adapter needs the picks to log what was
// actually injected (.lyte/memory/recall-log.jsonl), and the block alone cannot
// carry a score, so this is the seam: recall() stays the documented
// string-returning contract every existing adapter calls, and an adapter that
// measures recall calls this instead (2026-10-07).
function recallDetailed({ prompt, transcriptPath, repoRoot }) {
  try {
    const queryTerms = Array.from(new Set(tokenize(prompt)));
    if (queryTerms.length < MIN_MATCHED_TERMS) return EMPTY;

    const docs = scanLessons(repoRoot);
    if (docs.length === 0) return EMPTY;
    const corpus = buildCorpus(docs);

    let transcriptRaw = '';
    if (transcriptPath) {
      try {
        transcriptRaw = fs.readFileSync(transcriptPath, 'utf8');
      } catch {
        transcriptRaw = ''; // unreadable transcript → skip dedup, still work
      }
    }

    const ranked = [];
    for (const doc of docs) {
      const { score, matched } = scoreLesson(queryTerms, doc, corpus);
      if (score <= 0 || matched < MIN_MATCHED_TERMS) continue;
      ranked.push({ doc, score });
    }
    ranked.sort((a, b) => b.score - a.score);

    const top = ranked.length ? ranked[0].score : 0;
    const picked = ranked
      .filter((r) => r.score >= SCORE_FLOOR && r.score >= top * RELATIVE_FLOOR)
      .slice(0, MAX_LESSONS)
      // Dedup runs AFTER the slice, and a hit DROPS the slot rather than
      // backfilling: the next-ranked lesson is worse by construction, so
      // promoting it turns "you already have this" into "here is something
      // less relevant".
      .filter((r) => !alreadySeen(transcriptRaw, r.doc));

    if (picked.length === 0) return EMPTY;
    return {
      block: render(picked.map((r) => r.doc)),
      // worker + slug + score, and nothing else: the title is rendered from
      // the lesson file on disk by whoever reports on this, so carrying it
      // here would only bloat the log line.
      picked: picked.map((r) => ({
        worker: r.doc.worker,
        slug: r.doc.slug,
        // Two decimals: enough to rank, short enough to read in a log line.
        score: Math.round(r.score * 100) / 100,
      })),
    };
  } catch (e) {
    process.stderr.write('memory-recall: ' + (e && e.message ? e.message : e) + '\n');
    return EMPTY;
  }
}

// The documented contract (see the header): the injection block, or '' for
// silence.
function recall(args) {
  return recallDetailed(args).block;
}

module.exports = {
  logInjection,
  recall,
  recallDetailed,
  tokenize,
  scanLessons,
  lessonDoc,
  buildCorpus,
  scoreLesson,
  STOPWORDS,
  SCORE_FLOOR,
  RELATIVE_FLOOR,
  MIN_MATCHED_TERMS,
  MAX_LESSONS,
  MAX_CHARS,
};

// One JSON line per injection. Append-only, fail-soft, and never a reason the
// prompt does not get its lessons: every failure path here is a silent skip.
function logInjection(repoRoot, prompt, picked) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      // The hash is of the first 80 chars only, and 16 hex chars of it are
      // kept — an identifier for "this prompt again", not a recoverable prompt.
      prompt: crypto.createHash('sha256')
        .update(String(prompt || '').slice(0, 80))
        .digest('hex')
        .slice(0, 16),
      lessons: picked,
    });
    fs.appendFileSync(path.join(repoRoot, '.lyte', 'memory', 'recall-log.jsonl'), line + '\n');
  } catch {
    // no memory dir, a read-only checkout, a full disk — recall still happened
  }
}

function main() {
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    const repoRoot = path.resolve(__dirname, '..', '..'); // this hook lives at .claude/hooks/
    const detailed = recallDetailed({ prompt: payload.prompt, transcriptPath: payload.transcript_path, repoRoot });
    if (detailed.block) process.stdout.write(detailed.block);
    if (detailed.picked && detailed.picked.length > 0) logInjection(repoRoot, payload.prompt, detailed.picked);
  } catch {
    // fail-soft: bad stdin, unreadable memory — never wedge a prompt over recall
  }
  process.exit(0);
}

if (require.main === module) main();
