#!/usr/bin/env node
'use strict';
// IS: The headless re-cost job — the recipe-costing skill with no person in
//     the loop. Reads Ingredients, Recipes, Recipe Components and Recipe Cost
//     History through the field's entries API (GET /api/fields/{slug}/rays/
//     {id}/entries, scoped field token), builds the snapshot recost.cjs
//     documents, runs the calculator, applies the plan in its order
//     (component_updates → recipe_updates → history_creates, every write with
//     return_row: true and re-checked against what was sent), then re-reads
//     and re-runs and exits non-zero unless the second plan has ZERO writes.
//     Run twice on an unchanged field, the second run writes nothing and
//     passes — that is the idempotency contract .github/workflows/recost.yml
//     asserts.
// IS NOT: The arithmetic (recost.cjs beside this file does it), a writer of
//     Invoice Items, Vendor Items or Ingredients (it never touches them), or a
//     thing that writes a partial plan — any `errors` from the calculator stop
//     the job before the first write.
//
// Usage:
//   FIELD_SERVICE_TOKEN=lfs1.… node recost-job.cjs [--trigger invoice|recipe_change|cost_correction|baseline]
//        [--invoice-id <uuid>] [--costed-on YYYY-MM-DD] [--cost-source "US Foods 2023-07-03"]
//        [--dry-run] [--base-url https://app.lyte.works] [--report <path>]
//   node recost-job.cjs --self-test        (runs against an in-process mock of the entries API)
//
// Env: FIELD_SERVICE_TOKEN (required), FIELD_SLUG and APP_URL (each falls
//      back to `slug` / `app_url` in .lyte/field.json; neither has a built-in
//      default, so a repo before its hand-off stops with a named error). The
//      token is read from the environment and never printed; every log line is
//      a count, a title or a status code.
//
// Ray ids come ONLY from workers/skills/_shared/food-costs-ids.json, through
// its loader: a blank id there (a restaurant not handed off yet) stops the job
// before the first read, naming the file. There are no fallback ids.

var fs = require('fs');
var path = require('path');
var recost = require('./recost.cjs');
var idsLib = require('../_shared/food-costs-ids.cjs');

var ID_KEYS = ['recipes', 'recipe_components', 'recipe_cost_history', 'ingredients'];
var PAGE = 500;         // the entries API's row cap per read
var EPS = 0.00005;      // same tolerance as recost.cjs: below this a 4-dp number hasn't changed

// Throws IdsMissingError (named file, named keys) when any id is blank.
function loadIds(opts) {
  var json = idsLib.load(ID_KEYS.map(function (k) { return 'rays.' + k; }), opts);
  var ids = {};
  ID_KEYS.forEach(function (k) { ids[k] = json.rays[k].trim(); });
  return { ids: ids, source: idsLib.REL };
}

// The restaurant this repo belongs to: env first (the workflow sets it from a
// repo variable or .lyte/field.json), then .lyte/field.json itself.
function fieldIdentity() {
  var j = {};
  try { j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '.lyte', 'field.json'), 'utf8')) || {}; } catch (e) { j = {}; }
  return {
    slug: String(process.env.FIELD_SLUG || j.slug || '').trim(),
    appUrl: String(process.env.APP_URL || process.env.LYTE_APP_URL || j.app_url || '').trim(),
  };
}

function parseArgs(argv) {
  var a = { trigger: 'recipe_change', invoiceId: null, costedOn: null, costSource: null, dryRun: false, baseUrl: null, report: null, selfTest: false };
  for (var i = 2; i < argv.length; i++) {
    var k = argv[i], v = argv[i + 1];
    if (k === '--self-test') a.selfTest = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--trigger') { a.trigger = v; i++; }
    else if (k === '--invoice-id') { a.invoiceId = v || null; i++; }
    else if (k === '--costed-on') { a.costedOn = v; i++; }
    else if (k === '--cost-source') { a.costSource = v; i++; }
    else if (k === '--base-url') { a.baseUrl = v; i++; }
    else if (k === '--report') { a.report = v; i++; }
    else throw new Error('unknown argument ' + k);
  }
  if (['invoice', 'recipe_change', 'cost_correction', 'baseline'].indexOf(a.trigger) < 0) throw new Error('bad --trigger ' + a.trigger);
  if (a.invoiceId === '') a.invoiceId = null;
  if (!a.costedOn) a.costedOn = new Date().toISOString().slice(0, 10);
  if (a.costSource === '') a.costSource = null;
  return a;
}

// ── the entries API client ───────────────────────────────────────────────────
// One door: GET/POST /rays/{id}/entries, PATCH /rays/{id}/entries/{entryId}.
// Writes send return_row: true and the stored row is compared with what was
// sent — a write that did not land as sent is a failure, not a warning.

function makeClient(opts) {
  var who = fieldIdentity();
  var base = String(opts.baseUrl || who.appUrl).replace(/\/$/, '');
  var slug = opts.slug || who.slug;
  if (!slug) throw new Error('no field slug — set the FIELD_SLUG repo variable or `slug` in .lyte/field.json (the hand-off writes it)');
  if (!/^https:\/\//.test(base)) throw new Error('no app URL — set the FIELD_APP_URL repo variable or `app_url` in .lyte/field.json');
  var token = opts.token;
  var fetchImpl = opts.fetch || global.fetch;
  if (!fetchImpl) throw new Error('no fetch available — Node 18+ is required');
  var root = base + '/api/fields/' + encodeURIComponent(slug);

  async function call(method, pathname, body) {
    var res = await fetchImpl(root + pathname, {
      method: method,
      headers: Object.assign({ 'content-type': 'application/json', 'x-field-token': token }, body === undefined ? {} : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!res.ok) {
      var msg = (json && (json.error || json.message)) || text.slice(0, 300) || res.statusText;
      var err = new Error(method + ' ' + pathname.replace(/\/[0-9a-f-]{36}/g, '/…') + ' → HTTP ' + res.status + ': ' + msg);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // Every row of a ray. The API answers { entries, hasMore, nextCursor } like
  // list_entries on the MCP; a bare array is accepted too. A page that says
  // more rows remain is followed by cursor; a cursor that does not advance is
  // a hard stop rather than a silent half-snapshot.
  async function listAll(rayId) {
    var out = [], cursor = null, guard = 0;
    for (;;) {
      var q = '?limit=' + PAGE + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      var r = await call('GET', '/rays/' + rayId + '/entries' + q);
      var rows = Array.isArray(r) ? r : (r && r.entries) || [];
      out = out.concat(rows);
      var more = !Array.isArray(r) && r && r.hasMore === true;
      if (!more) break;
      if (!r.nextCursor || r.nextCursor === cursor || ++guard > 50) {
        throw new Error('ray ' + rayId + ' has more than ' + out.length + ' rows and the page cursor did not advance — refusing to re-cost from a partial snapshot');
      }
      cursor = r.nextCursor;
    }
    return out;
  }

  function rowOf(r) { return (r && r.entry) || r; }

  async function update(rayId, entryId, title, properties) {
    var body = { properties: properties, return_row: true };
    if (title) body.title = title;
    var r = await call('PATCH', '/rays/' + rayId + '/entries/' + entryId, body);
    return rowOf(r);
  }

  async function create(rayId, title, properties) {
    var r = await call('POST', '/rays/' + rayId + '/entries', { title: title, properties: properties, return_row: true });
    return rowOf(r);
  }

  return { listAll: listAll, update: update, create: create, root: root };
}

// ── snapshot ─────────────────────────────────────────────────────────────────

function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
function rel(v) { return Array.isArray(v) ? (v[0] || null) : (v || null); }   // a relation lyte stores the target entry id

function toSnapshot(raw, args) {
  var P = function (e) { return e.properties || {}; };
  return {
    trigger: args.trigger,
    invoice_id: args.invoiceId || null,
    costed_on: args.costedOn,
    cost_source: args.costSource || undefined,
    ingredients: raw.ingredients.map(function (e) { var p = P(e); return { id: e.id, name: p.name || e.title, unit: p.unit, last_cost: num(p.last_cost) }; }),
    recipes: raw.recipes.map(function (e) { var p = P(e); return {
      id: e.id, name: p.name || e.title, is_prep: !!p.is_prep, yield_quantity: num(p.yield_quantity), yield_unit: p.yield_unit,
      total_cost: num(p.total_cost), cost_per_yield_unit: num(p.cost_per_yield_unit), menu_price: num(p.menu_price), food_cost_pct: num(p.food_cost_pct) }; }),
    components: raw.components.map(function (e) { var p = P(e); return {
      id: e.id, recipe_id: rel(p.recipe_id), ingredient_id: rel(p.ingredient_id), sub_recipe_id: rel(p.sub_recipe_id),
      quantity: num(p.quantity), unit: p.unit, unit_cost: num(p.unit_cost), line_cost: num(p.line_cost), name: p.name || e.title, cost_math: p.cost_math }; }),
    history: raw.history.map(function (e) { var p = P(e); return {
      recipe_id: rel(p.recipe_id), costed_on: p.costed_on, cost_per_yield_unit: num(p.cost_per_yield_unit),
      food_cost_pct: num(p.food_cost_pct), menu_price: num(p.menu_price), created_at: e.createdAt || e.created_at }; }),
  };
}

async function readAll(client, ids) {
  var r = await Promise.all([client.listAll(ids.ingredients), client.listAll(ids.recipes), client.listAll(ids.recipe_components), client.listAll(ids.recipe_cost_history)]);
  return { ingredients: r[0], recipes: r[1], components: r[2], history: r[3] };
}

function writesIn(plan) { return plan.component_updates.length + plan.recipe_updates.length + plan.history_creates.length; }

// The stored row must carry what was sent. Numbers compare at the calculator's
// tolerance (the gate may coerce "0.40110" → 0.4011); strings compare exactly.
function landed(sent, stored) {
  var bad = [];
  Object.keys(sent).forEach(function (k) {
    var a = sent[k], b = stored ? stored[k] : undefined;
    if (typeof a === 'number') { if (num(b) === null || Math.abs(num(b) - a) >= EPS) bad.push(k); }
    else if (a === null || a === undefined) { /* nothing to assert */ }
    else if (String(a) !== String(b)) bad.push(k);
  });
  return bad;
}

async function applyPlan(client, ids, plan, log) {
  var i, row, bad, p;
  for (i = 0; i < plan.component_updates.length; i++) {
    p = plan.component_updates[i];
    row = await client.update(ids.recipe_components, p.id, undefined, p.properties);
    bad = landed(p.properties, row && row.properties);
    if (bad.length) throw new Error('component "' + p.title + '" did not land as sent: ' + bad.join(', '));
    log('  ~ component  ' + p.title);
  }
  for (i = 0; i < plan.recipe_updates.length; i++) {
    p = plan.recipe_updates[i];
    row = await client.update(ids.recipes, p.id, undefined, p.properties);
    bad = landed(p.properties, row && row.properties);
    if (bad.length) throw new Error('recipe "' + p.title + '" did not land as sent: ' + bad.join(', '));
    log('  ~ recipe     ' + p.title);
  }
  var created = [];
  for (i = 0; i < plan.history_creates.length; i++) {
    p = plan.history_creates[i];
    row = await client.create(ids.recipe_cost_history, p.title, p.properties);
    bad = landed(p.properties, row && row.properties);
    if (bad.length) throw new Error('history row "' + p.title + '" did not land as sent: ' + bad.join(', '));
    created.push(row);
    log('  + history    ' + p.title);
  }
  return created;
}

// ── the job ──────────────────────────────────────────────────────────────────

async function run(args, deps) {
  var log = (deps && deps.log) || function (s) { console.log(s); };
  var loaded = (deps && deps.ids) ? { ids: deps.ids, source: 'injected' } : loadIds(deps && deps.idsFile ? { file: deps.idsFile } : undefined);
  var ids = loaded.ids;
  var token = (deps && deps.token) || process.env.FIELD_SERVICE_TOKEN;
  if (!token) throw new Error('FIELD_SERVICE_TOKEN is not set — the job reads and writes the field through the entries API with a scoped field token from the repo secret of that name');
  var client = makeClient({ token: token, baseUrl: args.baseUrl || (deps && deps.baseUrl), fetch: deps && deps.fetch, slug: deps && deps.slug });
  log('re-cost · trigger ' + args.trigger + ' · costed_on ' + args.costedOn + (args.invoiceId ? ' · invoice ' + args.invoiceId : '') +
    (args.costSource ? ' · cost source ' + args.costSource : '') + ' · ids from ' + loaded.source + (args.dryRun ? ' · DRY RUN' : ''));

  // Pass 1: read → plan.
  var raw1 = await readAll(client, ids);
  log('read: ' + raw1.ingredients.length + ' ingredients · ' + raw1.recipes.length + ' recipes · ' + raw1.components.length + ' components · ' + raw1.history.length + ' history rows');
  var plan1 = recost.plan(toSnapshot(raw1, args));
  if (plan1.errors.length) {
    log('calculator errors — nothing written:');
    plan1.errors.forEach(function (e) { log('  ✗ ' + e); });
    throw new Error(plan1.errors.length + ' calculator error(s); never write a partial plan');
  }
  var w1 = writesIn(plan1);
  log('plan: ' + plan1.component_updates.length + ' component updates · ' + plan1.recipe_updates.length + ' recipe updates · ' + plan1.history_creates.length + ' history rows (' + w1 + ' writes) · order: ' + plan1.order.join(' → '));
  plan1.report.forEach(function (l) { log('  ' + l); });

  var result = { ids_source: loaded.source, pass1: { writes: w1, plan: plan1 }, pass2: null, created_history: [], converged: false, dry_run: !!args.dryRun };
  if (args.dryRun) { log('dry run: plan printed, nothing written'); result.converged = w1 === 0; return result; }

  // Apply in the calculator's order.
  if (w1 > 0) {
    log('applying:');
    result.created_history = await applyPlan(client, ids, plan1, log);
  } else {
    log('nothing to apply — the field already agrees with its inputs');
  }

  // Pass 2: re-read → re-plan → must be zero writes.
  var raw2 = await readAll(client, ids);
  var plan2 = recost.plan(toSnapshot(raw2, args));
  var w2 = writesIn(plan2);
  result.pass2 = { writes: w2, plan: plan2 };
  if (plan2.errors.length) {
    plan2.errors.forEach(function (e) { log('  ✗ ' + e); });
    throw new Error('second pass: ' + plan2.errors.length + ' calculator error(s)');
  }
  if (w2 !== 0) {
    log('second pass still plans ' + w2 + ' write(s):');
    plan2.component_updates.forEach(function (c) { log('  ~ component ' + c.title + ' ' + JSON.stringify(c.properties)); });
    plan2.recipe_updates.forEach(function (c) { log('  ~ recipe ' + c.title + ' ' + JSON.stringify(c.properties)); });
    plan2.history_creates.forEach(function (c) { log('  + history ' + c.title); });
    throw new Error('NOT CONVERGED: the second plan has ' + w2 + ' write(s); the field does not agree with itself after the apply');
  }
  result.converged = true;
  log('✓ converged: second pass plans 0 writes (first pass wrote ' + w1 + ')');
  return result;
}

function writeReport(file, args, result) {
  var lines = ['# Re-cost · ' + args.costedOn + ' · trigger ' + args.trigger, ''];
  lines.push('- ids: ' + result.ids_source);
  lines.push('- first pass: ' + result.pass1.writes + ' write(s) · second pass: ' + (result.pass2 ? result.pass2.writes : 'n/a') + ' · converged: ' + (result.converged ? 'yes' : 'NO'));
  if (result.dry_run) lines.push('- dry run — nothing written');
  lines.push('');
  if (result.pass1.plan.report.length) { lines.push('## Recipes that moved'); result.pass1.plan.report.forEach(function (l) { lines.push('- ' + l); }); }
  else lines.push('No recipe moved.');
  var alerts = result.pass1.plan.history_creates.filter(function (h) { return h.properties.alert; });
  lines.push(''); lines.push(alerts.length ? '## ⚠ Alerts' : '⚠ none over 30% · none up 2+ pts');
  alerts.forEach(function (h) { lines.push('- ' + h.title + ' — ' + h.properties.alert); });
  if (result.created_history.length) { lines.push(''); lines.push('## History rows written'); result.created_history.forEach(function (r) { lines.push('- ' + (r.title || r.id) + ' (`' + r.id + '`)'); }); }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// ── self-test: an in-process entries API over a copy of the field ───────────

function mockApi(seed) {
  var rays = JSON.parse(JSON.stringify(seed)); // ray id → [rows]
  var counter = 0;
  var calls = [];
  async function fetchImpl(url, init) {
    var m = /\/rays\/([^/?]+)\/entries(?:\/([^/?]+))?(?:\?.*)?$/.exec(url);
    var method = (init && init.method) || 'GET';
    calls.push(method + ' ' + (m ? m[1].slice(0, 8) : url));
    var hdr = (init && init.headers) || {};
    if (hdr['x-field-token'] !== 'lfs1.test') return resp(401, { error: 'Unauthorized' });
    if (!m || !rays[m[1]]) return resp(404, { error: 'Not found' });
    var rows = rays[m[1]];
    if (method === 'GET') return resp(200, { entries: rows, hasMore: false, nextCursor: null });
    var body = JSON.parse(init.body);
    if (method === 'POST' && !m[2]) {
      var row = { id: 'new-' + (++counter), rayId: m[1], title: body.title, properties: body.properties, createdAt: new Date().toISOString() };
      rows.push(row); return resp(200, body.return_row ? { entry: row } : { id: row.id });
    }
    if (method === 'PATCH' && m[2]) {
      var e = rows.filter(function (r) { return r.id === m[2]; })[0];
      if (!e) return resp(404, { error: 'Not found' });
      Object.assign(e.properties, body.properties); if (body.title) e.title = body.title;
      return resp(200, body.return_row ? { entry: e } : { id: e.id });
    }
    return resp(405, { error: 'Method not allowed' });
  }
  function resp(status, json) { var text = JSON.stringify(json); return { ok: status < 300, status: status, statusText: String(status), text: async function () { return text; } }; }
  return { fetch: fetchImpl, rays: rays, calls: calls };
}

async function selfTest() {
  var assert = require('assert');
  // Stand-in ids: the arithmetic and the apply loop are proved whether or not this repo is handed off.
  var ids = { recipes: 'test-recipes', recipe_components: 'test-components', recipe_cost_history: 'test-history', ingredients: 'test-ingredients' };
  var SLUG = 'test-restaurant', BASE = 'https://example.test';
  // A small field in steady state: one prep, one dish, ingredient costs that agree with the lines.
  var seed = {};
  seed[ids.ingredients] = [
    { id: 'aru', title: 'Baby Arugula', properties: { name: 'Baby Arugula', unit: 'oz', last_cost: 0.3005 } },
    { id: 'gar', title: 'Garlic, Peeled', properties: { name: 'Garlic, Peeled', unit: 'oz', last_cost: 0.2522 } },
    { id: 'oil', title: 'Extra Virgin Olive Oil', properties: { name: 'Extra Virgin Olive Oil', unit: 'fl oz', last_cost: 0.3744 } },
  ];
  seed[ids.recipes] = [
    { id: 'gc', title: 'Garlic Confit', properties: { name: 'Garlic Confit', is_prep: true, yield_quantity: 40, yield_unit: 'fl oz', total_cost: 16.016, cost_per_yield_unit: 0.4004 } },
    { id: 'sal', title: 'Salad', properties: { name: 'Salad', is_prep: false, yield_quantity: 1, yield_unit: 'portion', total_cost: 1.3019, cost_per_yield_unit: 1.3019, menu_price: 13, food_cost_pct: 10 } },
  ];
  seed[ids.recipe_components] = [
    { id: 'c1', title: 'x', properties: { recipe_id: 'gc', ingredient_id: 'gar', quantity: 16, unit: 'oz', unit_cost: 0.2522, line_cost: 4.0352, name: 'Garlic, Peeled · 16 oz · $4.04', cost_math: '16 oz × $0.2522 per oz (Garlic, Peeled last cost — US Foods 2023-06-26) = $4.0352' } },
    { id: 'c2', title: 'x', properties: { recipe_id: 'gc', ingredient_id: 'oil', quantity: 32, unit: 'fl oz', unit_cost: 0.3744, line_cost: 11.9808, name: 'Extra Virgin Olive Oil · 32 fl oz · $11.98', cost_math: '32 fl oz × $0.3744 per fl oz (Extra Virgin Olive Oil last cost — US Foods 2023-06-26) = $11.9808' } },
    { id: 'c3', title: 'x', properties: { recipe_id: 'sal', ingredient_id: 'aru', quantity: 3, unit: 'oz', unit_cost: 0.3005, line_cost: 0.9015, name: 'Baby Arugula · 3 oz · $0.90', cost_math: '3 oz × $0.3005 per oz (Baby Arugula last cost — US Foods 2023-06-26) = $0.9015' } },
    { id: 'c4', title: 'x', properties: { recipe_id: 'sal', sub_recipe_id: 'gc', quantity: 1, unit: 'fl oz', unit_cost: 0.4004, line_cost: 0.4004, name: 'Garlic Confit (prep) · 1 fl oz · $0.40', cost_math: '1 fl oz × $0.4004 per fl oz (Garlic Confit prep: $16.0160 batch ÷ 40 fl oz yield) = $0.4004' } },
  ];
  seed[ids.recipe_cost_history] = [
    { id: 'h1', title: 'x', createdAt: '2026-01-01T00:00:00Z', properties: { recipe_id: 'gc', costed_on: '2023-06-26', cost_per_yield_unit: 0.4004, trigger: 'baseline' } },
    { id: 'h2', title: 'x', createdAt: '2026-01-01T00:00:00Z', properties: { recipe_id: 'sal', costed_on: '2023-06-26', cost_per_yield_unit: 1.3019, food_cost_pct: 10, menu_price: 13, trigger: 'baseline' } },
  ];
  var quiet = function () {};
  var args = parseArgs(['n', 'j', '--trigger', 'invoice', '--invoice-id', 'inv2', '--costed-on', '2023-07-03', '--cost-source', 'US Foods 2023-07-03']);

  // 1. Steady state: zero writes on both passes, and nothing but GETs on the wire.
  var api = mockApi(seed);
  var r = await run(args, { fetch: api.fetch, token: 'lfs1.test', ids: ids, log: quiet, slug: SLUG, baseUrl: BASE });
  assert.strictEqual(r.pass1.writes, 0); assert.strictEqual(r.pass2.writes, 0); assert.ok(r.converged);
  assert.ok(api.calls.every(function (c) { return c.indexOf('GET') === 0; }), 'steady state must not write');

  // 2. A price move: first run writes, second run (same field) writes nothing. Never touches ingredients.
  var moved = JSON.parse(JSON.stringify(seed)); moved[ids.ingredients][1].properties.last_cost = 0.40;
  api = mockApi(moved);
  r = await run(args, { fetch: api.fetch, token: 'lfs1.test', ids: ids, log: quiet, slug: SLUG, baseUrl: BASE });
  assert.ok(r.pass1.writes > 0, 'garlic rise must plan writes'); assert.strictEqual(r.pass2.writes, 0); assert.ok(r.converged);
  assert.strictEqual(r.created_history.length, 2, 'confit and salad both moved');
  assert.ok(api.calls.every(function (c) { return !(c.indexOf('GET') !== 0 && c.indexOf(ids.ingredients.slice(0, 8)) >= 0); }), 'ingredients are read-only to this job');
  var again = await run(args, { fetch: api.fetch, token: 'lfs1.test', ids: ids, log: quiet, slug: SLUG, baseUrl: BASE });
  assert.strictEqual(again.pass1.writes, 0, 'a second job run on the unchanged field writes nothing');
  assert.ok(again.converged);

  // 3. Calculator errors stop the job before the first write.
  var broken = JSON.parse(JSON.stringify(seed)); broken[ids.recipe_components][2].properties.unit = 'lb';
  api = mockApi(broken);
  await assert.rejects(run(args, { fetch: api.fetch, token: 'lfs1.test', ids: ids, log: quiet, slug: SLUG, baseUrl: BASE }), /calculator error/);
  assert.ok(api.calls.every(function (c) { return c.indexOf('GET') === 0; }), 'an error plan writes nothing');

  // 4. A write that does not land as sent fails the job.
  var lossy = mockApi(moved);
  var realFetch = lossy.fetch;
  lossy.fetch = async function (url, init) {
    var res = await realFetch(url, init);
    if (init && init.method === 'PATCH') { var t = await res.text(); var j = JSON.parse(t); j.entry.properties.line_cost = 999; var s = JSON.stringify(j); return { ok: true, status: 200, statusText: '200', text: async function () { return s; } }; }
    return res;
  };
  await assert.rejects(run(args, { fetch: lossy.fetch, token: 'lfs1.test', ids: ids, log: quiet, slug: SLUG, baseUrl: BASE }), /did not land as sent/);

  // 5. No token → named failure before any read.
  var saved = process.env.FIELD_SERVICE_TOKEN; delete process.env.FIELD_SERVICE_TOKEN;
  await assert.rejects(run(args, { fetch: api.fetch, ids: ids, log: quiet, slug: SLUG, baseUrl: BASE }), /FIELD_SERVICE_TOKEN/);
  if (saved !== undefined) process.env.FIELD_SERVICE_TOKEN = saved;

  // 6. Dry run reads, plans, never writes.
  api = mockApi(moved);
  var dry = await run(parseArgs(['n', 'j', '--dry-run']), { fetch: api.fetch, token: 'lfs1.test', ids: ids, log: quiet, slug: SLUG, baseUrl: BASE });
  assert.ok(dry.pass1.writes > 0 && dry.pass2 === null && api.calls.every(function (c) { return c.indexOf('GET') === 0; }));

  // 7. Blank ids fail loudly: no id → a named error before any request, never an empty re-cost.
  var os = require('os');
  var blankFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ids-')), 'food-costs-ids.json');
  fs.writeFileSync(blankFile, JSON.stringify({ rays: { recipes: '', recipe_components: '', recipe_cost_history: '', ingredients: '' } }));
  assert.throws(function () { loadIds({ file: blankFile }); }, function (e) { return e.code === 'IDS_MISSING' && e.missing.length === 4 && /hand-off/.test(e.message); });
  var noCalls = [];
  await assert.rejects(run(args, { fetch: async function (u) { noCalls.push(u); throw new Error('must not be called'); }, token: 'lfs1.test',
    idsFile: blankFile, log: quiet, slug: SLUG, baseUrl: BASE }), /IDS_MISSING|table ids missing/);
  assert.strictEqual(noCalls.length, 0, 'blank ids must stop the job before the first request');
  // And the repo's own file: if it is still blank (the template), the real entry point refuses too.
  var own = null; try { loadIds(); } catch (e) { own = e; }
  if (own) assert.strictEqual(own.code, 'IDS_MISSING');

  // 8. No slug → named failure (no built-in restaurant to fall back on).
  var savedSlug = process.env.FIELD_SLUG; delete process.env.FIELD_SLUG;
  assert.throws(function () { makeClient({ token: 't', baseUrl: BASE, fetch: function () {}, slug: '' }); }, /FIELD_SLUG|slug/);
  if (savedSlug !== undefined) process.env.FIELD_SLUG = savedSlug;

  console.log('recost-job self-test: ok');
}

if (require.main === module) {
  var args;
  try { args = parseArgs(process.argv); } catch (e) { console.error(e.message); process.exit(2); }
  if (args.selfTest) { selfTest().then(function () { process.exit(0); }, function (e) { console.error(e && e.stack || e); process.exit(1); }); }
  else {
    run(args).then(function (result) {
      if (args.report) writeReport(args.report, args, result);
      process.exit(result.converged ? 0 : 1);
    }, function (e) {
      console.error('✗ ' + (e && e.message || e));
      if (args.report) { try { fs.writeFileSync(args.report, '# Re-cost FAILED · ' + args.costedOn + '\n\n' + (e && e.message || e) + '\n'); } catch (x) { /* report is best effort */ } }
      process.exit(1);
    });
  }
}

module.exports = { run: run, parseArgs: parseArgs, toSnapshot: toSnapshot, makeClient: makeClient, loadIds: loadIds, fieldIdentity: fieldIdentity };
