#!/usr/bin/env node
'use strict';
// IS: The invoice-intake + recipe-costing write checker — re-does the
//     arithmetic on every Invoice Items / Vendor Items / Ingredients / Recipe
//     Components / Recipes / Recipe Cost History row the field MCP just wrote
//     and hands any mismatch back to the model as a blocking reason. Wired as
//     a PostToolUse hook on `mcp__*__create_entry|update_entry` (see the
//     invoice-intake skill). Reads the Claude Code hook JSON on stdin; checks
//     only the stored row the tool returned (the skill writes with
//     `return_row: true`), so it never needs network or credentials.
// IS NOT: A gate on the MCP itself (the write has already landed — the model
//     fixes it), nor a cross-row check (links in both directions and the
//     invoice-total close are the skill's read-back steps).
//
// Exit 0 always. A problem is reported as {"decision":"block","reason":…}.
// `node check-write.cjs --self-test` runs the built-in cases.

// Table ids come from the one shared file — never a uuid literal here. Read
// lazily through the loader, which THROWS when the file is still blank (a repo
// before its hand-off): the hook then blocks every food-costs write with that
// message instead of silently checking nothing.
var idsLib = require('../../_shared/food-costs-ids.cjs');
var CHECKED = ['invoice_items', 'vendor_items', 'ingredients', 'recipe_components', 'recipes', 'recipe_cost_history'];
var IDS = null;
var RAYS = null;
function useIds(ids) {
  IDS = ids;
  RAYS = {};
  CHECKED.forEach(function (k) { RAYS[ids.rays[k]] = k; });
}
function ensureIds() {
  if (!RAYS) useIds(idsLib.load(CHECKED.map(function (k) { return 'rays.' + k; })));
}

// Stored key → the formula column that computes it on the ray. A row may carry
// both while the operator hasn't archived the stored one; once it's archived
// only the _calc value comes back, and the checks read that instead.
var CALC = {
  invoice_items: ['base_qty', 'cost_per_base_unit', 'case_rate', 'split_rate', 'split_premium_pct', 'split_premium'],
  recipes: ['cost_per_yield_unit', 'food_cost_pct'],
  recipe_cost_history: ['change_amount', 'change_pct', 'food_cost_change_pts'],
};

// The stored value when there is one, else the computed one. Read-only
// columns written by the model are reported, not merged.
function withCalc(kind, p, written, problems) {
  var out = Object.assign({}, p);
  (CALC[kind] || []).forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(written, k + '_calc')) {
      problems.push('`' + k + '_calc` is a formula — never write it');
    }
    if ((out[k] === undefined || out[k] === null) && num(p[k + '_calc']) !== null) out[k] = p[k + '_calc'];
  });
  return out;
}

// The food-cost line the recipe-costing skill alerts on.
var FOOD_COST_ALERT_PCT = 30;
var FOOD_COST_ALERT_PTS = 2;

// How many base units one `each` of a pack holds, by each-unit → base-unit.
var TO_OZ = { oz: 1, lb: 16, g: 0.035274, kg: 35.274 };
var TO_FLOZ = { 'fl oz': 1, l: 33.814, ml: 0.033814, gal: 128, qt: 32, pt: 16 };
var BASE_UNITS = { oz: 1, 'fl oz': 1, each: 1 };

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function close(a, b, rel, abs) { return Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel); }
function money(v) { return '$' + v.toFixed(2); }

// Expected base units in one case, or null when the pack can't be converted
// without facts the row doesn't carry (each_weight / density live on the
// ingredient; the skill handles those crossovers by asking).
function expectedBasePerCase(row) {
  var count = num(row.pack_count), size = num(row.pack_each_size);
  var unit = String(row.pack_each_unit || '').toLowerCase().trim();
  var base = String(row.base_unit || '').toLowerCase().trim();
  if (count === null || size === null || !unit || !base) return null;
  if (base === 'oz' && TO_OZ[unit] !== undefined) return count * size * TO_OZ[unit];
  if (base === 'fl oz' && TO_FLOZ[unit] !== undefined) return count * size * TO_FLOZ[unit];
  if (base === 'each') return unit === 'ea' || unit === 'each' ? count * size : count;
  return null;
}

function checkInvoiceItem(p, problems) {
  var qty = num(p.quantity), price = num(p.unit_price), total = num(p.total_cost);
  ['invoice_id', 'delivery_date', 'quantity', 'unit', 'unit_price', 'total_cost', 'category', 'storage'].forEach(function (k) {
    if (p[k] === undefined || p[k] === null || p[k] === '') problems.push('missing `' + k + '`');
  });
  if (qty !== null && price !== null && total !== null && !close(qty * price, total, 0, 0.011)) {
    problems.push('quantity × unit_price = ' + money(qty * price) + ' but total_cost = ' + money(total));
  }
  var unit = String(p.unit || '').toUpperCase();
  if (unit && unit !== 'CS' && unit !== 'EA') problems.push('`unit` is "' + p.unit + '" — must be CS or EA');
  if (unit === 'CS' && num(p.case_price) !== null && price !== null && !close(price, p.case_price, 0, 0.005)) {
    problems.push('CS line but unit_price ' + money(price) + ' ≠ case_price ' + money(p.case_price));
  }
  if (unit === 'EA' && num(p.split_price) !== null && price !== null && !close(price, p.split_price, 0, 0.005)) {
    problems.push('EA (split) line but unit_price ' + money(price) + ' ≠ split_price ' + money(p.split_price));
  }
  var bq = num(p.base_qty), cpb = num(p.cost_per_base_unit);
  if ((bq === null) !== (cpb === null)) problems.push('`base_qty` and `cost_per_base_unit` must be written together');
  if (bq !== null && cpb !== null && total !== null && !close(bq * cpb, total, 0.002, 0.02)) {
    problems.push('base_qty × cost_per_base_unit = ' + money(bq * cpb) + ' but total_cost = ' + money(total) +
      ' — the conversion and the price disagree');
  }
  if (p.vendor_item_id && bq === null) problems.push('linked to a vendor item but `base_qty` / `cost_per_base_unit` are empty');
  if (bq !== null && !p.vendor_item_id) problems.push('`base_qty` set with no `vendor_item_id` — where did the conversion come from?');
  checkSplit(p, problems);
}

// Case rate / split rate / split premium. Rates are $ per BASE unit; the
// premium is what THIS line paid over the case rate (0 on a full-case line).
function checkSplit(p, problems) {
  var qty = num(p.quantity), bq = num(p.base_qty), count = num(p.pack_count);
  var cp = num(p.case_price), sp = num(p.split_price);
  var unit = String(p.unit || '').toUpperCase();
  if (qty === null || bq === null || count === null || cp === null || !qty) return;
  var perCase = unit === 'EA' ? bq * count / qty : bq / qty;
  if (!(perCase > 0)) return;
  var cr = num(p.case_rate), srate = num(p.split_rate), pct = num(p.split_premium_pct), prem = num(p.split_premium);
  if (cr === null) problems.push('missing `case_rate` (case_price ÷ base units per case)');
  else if (!close(cr, cp / perCase, 0.005, 0.0002)) {
    problems.push('case_rate ' + cr + ' ≠ case_price ÷ base units/case = ' + (cp / perCase).toFixed(4));
  }
  var sellsSplit = sp !== null && !close(sp, cp, 0, 0.005);
  if (!sellsSplit) {
    if (srate !== null || pct !== null) problems.push('split_price = case_price (not sold split) — leave `split_rate` and `split_premium_pct` blank, not 0');
  } else {
    var wantRate = sp / (perCase / count);
    var wantPct = (sp / (cp / count) - 1) * 100;
    if (srate === null) problems.push('missing `split_rate` (split_price ÷ base units in one pack)');
    else if (!close(srate, wantRate, 0.005, 0.0002)) problems.push('split_rate ' + srate + ' ≠ ' + wantRate.toFixed(4));
    if (pct === null) problems.push('missing `split_premium_pct`');
    else if (!close(pct, wantPct, 0, 0.15)) problems.push('split_premium_pct ' + pct + ' ≠ ' + wantPct.toFixed(1));
  }
  var wantPrem = unit === 'EA' && sp !== null ? qty * (sp - cp / count) : 0;
  if (prem === null) problems.push('missing `split_premium` ($ paid over the case rate; 0 on a full-case line)');
  else if (!close(prem, wantPrem, 0, 0.011)) problems.push('split_premium ' + money(prem) + ' ≠ ' + money(wantPrem));
}

function checkVendorItem(p, problems, written) {
  var bpc = num(p.base_units_per_case);
  if (!p.ingredient_id) problems.push('vendor item has no `ingredient_id`');
  if (!BASE_UNITS[p.base_unit]) problems.push('`base_unit` is "' + p.base_unit + '" — must be oz, fl oz or each');
  if (bpc === null) problems.push('missing `base_units_per_case`');
  var want = expectedBasePerCase(p);
  if (bpc !== null && want !== null && !close(bpc, want, 0.005, 0.01)) {
    problems.push('base_units_per_case = ' + bpc + ' but the pack (' + p.pack_count + ' × ' + p.pack_each_size + ' ' +
      p.pack_each_unit + ' → ' + p.base_unit + ') works out to ' + Math.round(want * 100) / 100);
  }
  if (bpc !== null && want === null) {
    problems.push('the pack (' + p.pack_each_unit + ' → ' + p.base_unit + ') can\'t be converted from the row alone — ' +
      'confirm it uses the ingredient\'s each_weight/density and say so in the report');
  }
  var conv = String(p.conversion || '');
  if (!conv) problems.push('missing `conversion` (the readable working, e.g. "2 bags × 2 lb × 16 = 64 oz")');
  else if (bpc !== null) {
    var m = conv.match(/=\s*([\d.,]+)\s*([a-z ]+)\s*$/i);
    if (!m || !close(parseFloat(m[1].replace(/,/g, '')), bpc, 0.001, 0.01) || m[2].trim().toLowerCase() !== String(p.base_unit).toLowerCase()) {
      problems.push('`conversion` "' + conv + '" doesn\'t end in "= ' + bpc + ' ' + p.base_unit + '"');
    }
  }
  if (written && written.verified === true) {
    problems.push('`verified` was set to true by the model — only the operator ticks Verified. Set it back to false');
  }
}

function checkIngredient(p, problems) {
  if (p.unit && !BASE_UNITS[p.unit]) problems.push('`unit` is "' + p.unit + '" — the base unit must be oz, fl oz or each');
  if (p.last_cost !== undefined && !(num(p.last_cost) > 0)) problems.push('`last_cost` must be a positive number');
  if (num(p.each_weight) !== null && !p.each_weight_source) {
    problems.push('`each_weight` set without `each_weight_source` (measured in kitchen / spec sheet / label, + date)');
  }
  if (p.each_weight_source && num(p.each_weight) === null) problems.push('`each_weight_source` set but `each_weight` is empty');
}

function checkComponent(p, problems) {
  var hasIng = !!p.ingredient_id, hasSub = !!p.sub_recipe_id;
  if (!p.recipe_id) problems.push('component has no `recipe_id`');
  if (hasIng === hasSub) problems.push('a component points at exactly ONE of `ingredient_id` / `sub_recipe_id`');
  if (p.sub_recipe_id && p.sub_recipe_id === p.recipe_id) problems.push('a recipe can\'t use itself as a sub-recipe');
  var q = num(p.quantity), uc = num(p.unit_cost), lc = num(p.line_cost);
  ['quantity', 'unit', 'unit_cost', 'line_cost', 'name', 'cost_math'].forEach(function (k) {
    if (p[k] === undefined || p[k] === null || p[k] === '') problems.push('missing `' + k + '`');
  });
  if (q !== null && uc !== null && lc !== null && !close(q * uc, lc, 0, 0.00011)) {
    problems.push('quantity × unit_cost = ' + (q * uc).toFixed(4) + ' but line_cost = ' + lc);
  }
  var cm = String(p.cost_math || '');
  if (cm && lc !== null) {
    var end = cm.match(/=\s*\$([\d.,]+)\s*$/);
    if (!end || !close(parseFloat(end[1].replace(/,/g, '')), lc, 0, 0.00011)) {
      problems.push('`cost_math` doesn\'t end in "= $' + lc.toFixed(4) + '"');
    }
    if (uc !== null && cm.indexOf('$' + uc.toFixed(4)) === -1) {
      problems.push('`cost_math` doesn\'t show the unit cost $' + uc.toFixed(4));
    }
  }
}

function checkRecipe(p, problems) {
  var t = num(p.total_cost), y = num(p.yield_quantity), c = num(p.cost_per_yield_unit), mp = num(p.menu_price), f = num(p.food_cost_pct);
  if (t !== null && y !== null && c !== null && y > 0 && !close(t / y, c, 0, 0.00011)) {
    problems.push('total_cost ÷ yield_quantity = ' + (t / y).toFixed(4) + ' but cost_per_yield_unit = ' + c);
  }
  if (p.is_prep === true && !p.yield_unit) problems.push('a prep recipe needs `yield_unit` — it\'s the unit parent recipes buy it in');
  if (mp !== null && c !== null && mp > 0) {
    if (f === null) problems.push('menu_price set but `food_cost_pct` is empty');
    else if (!close(c / mp * 100, f, 0, 0.06)) problems.push('food_cost_pct ' + f + ' ≠ cost ÷ price = ' + (c / mp * 100).toFixed(1));
  }
  if (p.is_prep === true && f !== null) problems.push('a prep recipe has no menu price — leave `food_cost_pct` empty');
}

function checkHistory(p, problems, written) {
  ['name', 'recipe_id', 'trigger', 'costed_on', 'total_cost', 'cost_per_yield_unit'].forEach(function (k) {
    if (p[k] === undefined || p[k] === null || p[k] === '') problems.push('missing `' + k + '`');
  });
  var t = num(p.total_cost), y = num(p.yield_quantity), c = num(p.cost_per_yield_unit), mp = num(p.menu_price), f = num(p.food_cost_pct);
  if (t !== null && y !== null && c !== null && y > 0 && !close(t / y, c, 0, 0.00011)) problems.push('total_cost ÷ yield ≠ cost_per_yield_unit');
  if (mp !== null && c !== null && mp > 0 && (f === null || !close(c / mp * 100, f, 0, 0.06))) problems.push('food_cost_pct doesn\'t match cost ÷ price');
  if (p.trigger === 'invoice' && !p.invoice_id) problems.push('trigger is invoice but `invoice_id` is empty');
  var prev = num(p.prev_cost_per_yield_unit), ch = num(p.change_amount), chp = num(p.change_pct);
  if (p.trigger === 'baseline') {
    if (prev !== null || ch !== null) problems.push('a baseline row has no previous cost — leave the change fields empty');
  } else if (prev === null) {
    problems.push('a non-baseline row needs `prev_cost_per_yield_unit` (the recipe\'s latest earlier snapshot)');
  } else if (!p.prev_snapshot_id) {
    problems.push('a non-baseline row needs `prev_snapshot_id` (that earlier snapshot\'s id — food_cost_change_pts_calc reads it)');
  } else if (c !== null) {
    if (ch === null || !close(c - prev, ch, 0, 0.00011)) problems.push('change_amount ≠ cost − previous = ' + (c - prev).toFixed(4));
    if (prev > 0 && (chp === null || !close((c / prev - 1) * 100, chp, 0, 0.06))) problems.push('change_pct ≠ ' + ((c / prev - 1) * 100).toFixed(1));
    if (ch !== null && !close(ch, 0, 0, 0.00005) && !p.drivers) problems.push('cost moved but `drivers` is empty — name what changed');
  }
  var pts = num(p.food_cost_change_pts);
  var shouldAlert = (f !== null && f > FOOD_COST_ALERT_PCT) || (pts !== null && pts >= FOOD_COST_ALERT_PTS);
  if (shouldAlert && !p.alert) problems.push('food cost is over ' + FOOD_COST_ALERT_PCT + '% or up ' + FOOD_COST_ALERT_PTS + '+ pts — `alert` must say so');
  if (!shouldAlert && p.alert) problems.push('`alert` set but the row is under both alert lines');
  if (written && Object.keys(written).length && written.__isUpdate) problems.push('history rows are append-only — create a new row, don\'t edit an old one');
}

// Pure: hook payload → list of problems (empty = clean), or null = not ours.
function check(payload) {
  var name = String(payload && payload.tool_name || '');
  if (!/__(create_entry|update_entry)$/.test(name)) return null;
  var input = payload.tool_input || {};
  var resp = payload.tool_response;
  if (Array.isArray(resp)) resp = resp.map(function (b) { return b && b.text; }).join('');
  if (resp && typeof resp === 'object' && typeof resp.text === 'string') resp = resp.text;
  if (typeof resp === 'string') { try { resp = JSON.parse(resp); } catch (e) { resp = null; } }
  var row = resp && resp.entry;
  var rayId = (row && row.rayId) || input.ray_id;
  try { ensureIds(); } catch (e) {
    return ['the write checker cannot run: ' + e.message + ' Stop writing food-costs rows until the ids file is filled.'];
  }
  var kind = RAYS[rayId];
  var written = input.properties || {};
  if (!kind) {
    // An update without ray_id and without return_row: we can't tell which ray
    // it hit. If it carries this skill's keys, ask for the checkable form.
    var ours = ['base_qty', 'cost_per_base_unit', 'base_units_per_case', 'base_unit', 'conversion', 'verified', 'vendor_item_id',
      'each_weight', 'each_weight_source', 'unit_price', 'case_price', 'split_price', 'total_cost', 'last_cost', 'invoice_items',
      'unit_cost', 'line_cost', 'cost_math', 'cost_per_yield_unit', 'food_cost_pct', 'sub_recipe_id', 'components']
      .some(function (k) { return Object.prototype.hasOwnProperty.call(written, k); });
    if (ours && !row) return ['write to an invoice/vendor/ingredient row without `return_row: true` — it can\'t be checked. ' +
      'Re-read it (get_entry) and confirm the stored values, and pass return_row: true on these writes'];
    return null;
  }
  if (!row) return ['write to ' + kind.replace('_', ' ') + ' without `return_row: true` — it can\'t be checked. ' +
    'Re-read it (get_entry) and confirm the stored values, and pass return_row: true on these writes'];
  var problems = [];
  var p = withCalc(kind, row.properties || {}, written, problems);
  if (kind === 'invoice_items') checkInvoiceItem(p, problems);
  if (kind === 'vendor_items') checkVendorItem(p, problems, written);
  if (kind === 'ingredients') checkIngredient(p, problems);
  if (kind === 'recipe_components') checkComponent(p, problems);
  if (kind === 'recipes') checkRecipe(p, problems);
  if (kind === 'recipe_cost_history') {
    checkHistory(p, problems, Object.assign({}, written, { __isUpdate: /__update_entry$/.test(name) }));
  }
  if (/\\"/.test(String(row.title || ''))) problems.push('title contains a literal \\" — write inch marks as "in"');
  return problems.map(function (s) { return '"' + (row.title || row.id) + '": ' + s; });
}

function selfTest() {
  var assert = require('assert');
  // Loud when blank: a repo before its hand-off blocks the write and names the file.
  var blank = check({ tool_name: 'mcp__x__create_entry', tool_input: { ray_id: 'r', properties: { title: 'x' } },
    tool_response: [{ type: 'text', text: '{"entry":{"id":"e","rayId":"r","properties":{}}}' }] });
  if (!RAYS) {
    assert.ok(blank && blank.length === 1 && /food-costs-ids\.json/.test(blank[0]) && /hand-off/.test(blank[0]), 'blank ids must block, naming the file');
  }
  // The cases below run against stand-in ids, so the arithmetic is proved whether or not this repo is handed off.
  useIds({ rays: { invoice_items: 'test-ii', vendor_items: 'test-vi', ingredients: 'test-in', recipe_components: 'test-rc',
    recipes: 'test-re', recipe_cost_history: 'test-rh' } });
  function wrap(rayId, props, title, input) {
    return { tool_name: 'mcp__field__update_entry', tool_input: input || { properties: {} },
      tool_response: [{ type: 'text', text: JSON.stringify({ entry: { id: 'x', rayId: rayId, title: title || 'T', properties: props } }) }] };
  }
  var VI = IDS.rays.vendor_items, II = IDS.rays.invoice_items, IN = IDS.rays.ingredients;
  var arugulaVI = { ingredient_id: 'i', base_unit: 'oz', base_units_per_case: 64, pack_count: 2, pack_each_size: 2,
    pack_each_unit: 'lb', conversion: '2 bags × 2 lb × 16 = 64 oz' };
  assert.deepStrictEqual(check(wrap(VI, arugulaVI)), []);
  assert.strictEqual(check(wrap(VI, Object.assign({}, arugulaVI, { base_units_per_case: 32 }))).length, 2);
  assert.deepStrictEqual(check(wrap(VI, { ingredient_id: 'i', base_unit: 'fl oz', base_units_per_case: 338.14, pack_count: 1,
    pack_each_size: 10, pack_each_unit: 'L', conversion: '1 bag-in-box × 10 L × 33.814 = 338.14 fl oz' })), []);
  assert.deepStrictEqual(check(wrap(VI, { ingredient_id: 'i', base_unit: 'each', base_units_per_case: 120, pack_count: 10,
    pack_each_size: 12, pack_each_unit: 'ea', conversion: '10 packs × 12 = 120 each' })), []);
  assert.deepStrictEqual(check(wrap(VI, { ingredient_id: 'i', base_unit: 'each', base_units_per_case: 12, pack_count: 12,
    pack_each_size: 0.5, pack_each_unit: 'pt', conversion: '12 clamshells (½ pt each) = 12 each' })), []);
  assert.deepStrictEqual(check(wrap(VI, { ingredient_id: 'i', base_unit: 'oz', base_units_per_case: 80.15, pack_count: 7,
    pack_each_size: 11.45, pack_each_unit: 'oz', conversion: '7 logs × 11.45 oz = 80.15 oz' })), []);
  assert.strictEqual(check(wrap(VI, arugulaVI, 'T', { properties: { verified: true } })).length, 1);
  var line = { invoice_id: 'v', delivery_date: '2023-06-26', quantity: 3, unit: 'CS', unit_price: 19.23, case_price: 19.23, split_price: 14.42,
    total_cost: 57.69, category: 'produce', storage: 'refrigerated', vendor_item_id: 'vi', base_qty: 192, cost_per_base_unit: 0.3005,
    pack_count: 2, case_rate: 0.3005, split_rate: 0.4506, split_premium_pct: 50, split_premium: 0 };
  assert.deepStrictEqual(check(wrap(II, line)), []);
  assert.ok(check(wrap(II, Object.assign({}, line, { base_qty: 64 }))).length >= 1);
  assert.ok(check(wrap(II, Object.assign({}, line, { total_cost: 57.96 }))).length >= 2);
  var parm = Object.assign({}, line, { quantity: 1, unit: 'EA', unit_price: 41.21, case_price: 122.1, split_price: 41.21,
    total_cost: 41.21, base_qty: 80, cost_per_base_unit: 0.5151, pack_count: 4, case_rate: 0.3816, split_rate: 0.5151,
    split_premium_pct: 35, split_premium: 10.69 });
  assert.deepStrictEqual(check(wrap(II, parm)), []);
  assert.strictEqual(check(wrap(II, Object.assign({}, parm, { split_premium: 0 }))).length, 1);
  assert.strictEqual(check(wrap(II, Object.assign({}, parm, { split_premium_pct: 50 }))).length, 1);
  var noSplit = Object.assign({}, line, { quantity: 1, unit_price: 74.3, case_price: 74.3, split_price: 74.3, total_cost: 74.3,
    base_qty: 640, cost_per_base_unit: 0.1161, pack_count: 4, case_rate: 0.1161, split_premium: 0 });
  delete noSplit.split_rate; delete noSplit.split_premium_pct;
  assert.deepStrictEqual(check(wrap(II, noSplit)), []);
  assert.strictEqual(check(wrap(II, Object.assign({}, noSplit, { split_premium_pct: 0 }))).length, 1);
  // Stored + _calc side by side, _calc alone (stored archived), and a _calc written by the model
  var both = Object.assign({}, line, { base_qty_calc: 192, cost_per_base_unit_calc: 0.3005, case_rate_calc: 0.3005,
    split_rate_calc: 0.4506, split_premium_pct_calc: 50, split_premium_calc: 0 });
  assert.deepStrictEqual(check(wrap(II, both)), []);
  var calcOnly = Object.assign({}, both);
  ['base_qty', 'cost_per_base_unit', 'case_rate', 'split_rate', 'split_premium_pct', 'split_premium'].forEach(function (k) { delete calcOnly[k]; });
  assert.deepStrictEqual(check(wrap(II, calcOnly)), []);
  assert.strictEqual(check(wrap(II, both, 'T', { properties: { case_rate_calc: 0.3005 } })).length, 1);
  assert.strictEqual(check(wrap(II, Object.assign({}, line, { delivery_date: null }))).length, 1);
  assert.deepStrictEqual(check(wrap(IN, { unit: 'oz', last_cost: 0.3005 })), []);
  assert.strictEqual(check(wrap(IN, { unit: 'lb', last_cost: 0.3, each_weight: 2.5 })).length, 2);
  // Recipe Components
  var RC = IDS.rays.recipe_components, RE = IDS.rays.recipes, RH = IDS.rays.recipe_cost_history;
  var comp = { recipe_id: 'r', ingredient_id: 'i', quantity: 3, unit: 'oz', unit_cost: 0.3005, line_cost: 0.9015,
    name: 'Baby Arugula · 3 oz · $0.90', cost_math: '3 oz × $0.3005 per oz (Baby Arugula last cost — US Foods 2023-06-26) = $0.9015' };
  assert.deepStrictEqual(check(wrap(RC, comp)), []);
  assert.strictEqual(check(wrap(RC, Object.assign({}, comp, { line_cost: 0.95 }))).length, 2);
  assert.strictEqual(check(wrap(RC, Object.assign({}, comp, { sub_recipe_id: 's' }))).length, 1);
  assert.strictEqual(check(wrap(RC, Object.assign({}, comp, { sub_recipe_id: 'r', ingredient_id: null }))).length, 1);
  // Recipes
  var menu = { is_prep: false, total_cost: 2.5615, yield_quantity: 1, yield_unit: 'portion', cost_per_yield_unit: 2.5615, menu_price: 13, food_cost_pct: 19.7 };
  assert.deepStrictEqual(check(wrap(RE, menu)), []);
  assert.strictEqual(check(wrap(RE, Object.assign({}, menu, { food_cost_pct: 25 }))).length, 1);
  assert.deepStrictEqual(check(wrap(RE, { is_prep: true, total_cost: 16.043, yield_quantity: 40, yield_unit: 'fl oz', cost_per_yield_unit: 0.4011 })), []);
  assert.strictEqual(check(wrap(RE, { is_prep: true, total_cost: 16.043, yield_quantity: 40, yield_unit: 'fl oz', cost_per_yield_unit: 0.5 })).length, 1);
  // Recipe Cost History — created, never updated
  function created(rayId, props) { var w = wrap(rayId, props); w.tool_name = 'mcp__field__create_entry'; return w; }
  var base = { name: 'Salad · 2023-06-26 · $2.56 · 19.7%', recipe_id: 'r', invoice_id: 'v', trigger: 'baseline', costed_on: '2023-06-26',
    total_cost: 2.5615, yield_quantity: 1, yield_unit: 'portion', cost_per_yield_unit: 2.5615, menu_price: 13, food_cost_pct: 19.7 };
  assert.deepStrictEqual(check(created(RH, base)), []);
  assert.strictEqual(check(wrap(RH, base)).length, 1);
  var moved = Object.assign({}, base, { trigger: 'invoice', total_cost: 2.6677, cost_per_yield_unit: 2.6677, food_cost_pct: 20.5,
    prev_snapshot_id: 'h0', prev_cost_per_yield_unit: 2.5615, change_amount: 0.1062, change_pct: 4.1, food_cost_change_pts: 0.8,
    drivers: 'Baby Arugula $0.3005 → $0.3359/oz (+11.8%)' });
  assert.deepStrictEqual(check(created(RH, moved)), []);
  assert.strictEqual(check(created(RH, Object.assign({}, moved, { prev_snapshot_id: null }))).length, 1);
  var movedCalc = Object.assign({}, moved, { change_amount_calc: 0.1062, change_pct_calc: 4.1, food_cost_change_pts_calc: 0.8 });
  delete movedCalc.change_amount; delete movedCalc.change_pct; delete movedCalc.food_cost_change_pts;
  assert.deepStrictEqual(check(created(RH, movedCalc)), []);
  assert.deepStrictEqual(check(wrap(RE, Object.assign({}, menu, { cost_per_yield_unit: null, food_cost_pct: null,
    cost_per_yield_unit_calc: 2.5615, food_cost_pct_calc: 19.7 }))), []);
  assert.strictEqual(check(created(RH, Object.assign({}, moved, { drivers: '' }))).length, 1);
  assert.strictEqual(check(created(RH, Object.assign({}, moved, { food_cost_change_pts: 2.4 }))).length, 1);
  assert.deepStrictEqual(check(created(RH, Object.assign({}, moved, { food_cost_change_pts: 2.4, alert: '+2.4 pts in one re-cost' }))), []);
  assert.strictEqual(check({ tool_name: 'mcp__x__list_entries', tool_input: {} }), null);
  assert.strictEqual(check({ tool_name: 'mcp__x__update_entry', tool_input: { entry_id: 'e', properties: { title: 'x' } },
    tool_response: [{ type: 'text', text: '{"id":"e"}' }] }), null);
  assert.strictEqual(check({ tool_name: 'mcp__x__update_entry', tool_input: { entry_id: 'e', properties: { base_qty: 1 } },
    tool_response: [{ type: 'text', text: '{"id":"e"}' }] }).length, 1);
  console.log('check-write self-test: ok');
}

if (require.main === module) {
  if (process.argv[2] === '--self-test') { selfTest(); process.exit(0); }
  var buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (c) { buf += c; });
  process.stdin.on('end', function () {
    var payload;
    try { payload = JSON.parse(buf || '{}'); } catch (e) { process.exit(0); }
    var problems = null;
    try { problems = check(payload); } catch (e) { process.exit(0); }
    if (problems && problems.length) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: 'invoice-intake check failed — fix before continuing:\n- ' + problems.join('\n- '),
      }));
    }
    process.exit(0);
  });
}

module.exports = { check: check, expectedBasePerCase: expectedBasePerCase, useIds: useIds };
