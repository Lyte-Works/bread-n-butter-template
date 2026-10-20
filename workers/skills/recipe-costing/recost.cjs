#!/usr/bin/env node
'use strict';
// IS: The recipe-costing calculator — takes a JSON snapshot of the field's
//     Ingredients, Recipes, Recipe Components and Recipe Cost History rows,
//     re-costs EVERY recipe bottom-up (sub-recipes before the recipes that use
//     them), and prints the exact write plan: component updates, recipe
//     updates, history rows to create, and a report. Pure arithmetic, no
//     network — the recipe-costing skill reads the rows, runs this, applies
//     the plan, and the write checker verifies every row as it lands.
// IS NOT: A writer (it never touches the field) or a judge of whether a cost
//     is right — it only makes the numbers follow from the inputs.
//
// Usage: node recost.cjs <snapshot.json>      → plan JSON on stdout
//        node recost.cjs --self-test
//
// snapshot.json:
// { "trigger": "invoice"|"recipe_change"|"cost_correction"|"baseline",
//   "invoice_id": "<uuid or null>", "costed_on": "YYYY-MM-DD",
//   "cost_source": "US Foods 2023-06-26",          // optional: replaces the
//                                                   // vendor/date in ingredient cost_math
//   "ingredients": [{ "id","name","unit","last_cost" }],
//   "recipes":     [{ "id","name","is_prep","yield_quantity","yield_unit",
//                     "total_cost","cost_per_yield_unit","menu_price","food_cost_pct" }],
//   "components":  [{ "id","recipe_id","ingredient_id","sub_recipe_id","quantity",
//                     "unit","unit_cost","line_cost","name","cost_math" }],
//   "history":     [{ "id","recipe_id","costed_on","cost_per_yield_unit","food_cost_pct","menu_price","created_at" }] }

var ALERT_PCT = 30;   // menu recipe food cost above this → alert
var ALERT_PTS = 2;    // food cost up this many points or more in one re-cost → alert
var EPS = 0.00005;    // below this a 4-decimal number hasn't changed

function r4(x) { return Math.round(x * 10000) / 10000; }
function r1(x) { return Math.round(x * 10) / 10; }
function d4(x) { return '$' + x.toFixed(4); }
function d2(x) { return '$' + x.toFixed(2); }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function moved(a, b) { return a === null || b === null || Math.abs(a - b) >= EPS; }
function pct(a, b) { return b ? (a / b - 1) * 100 : 0; }
function signed(x, digits) { return (x >= 0 ? '+' : '') + x.toFixed(digits); }

function plan(snap) {
  var errors = [];
  var ing = {}; (snap.ingredients || []).forEach(function (i) { ing[i.id] = i; });
  var rec = {}; (snap.recipes || []).forEach(function (r) { rec[r.id] = r; });
  var byRecipe = {};
  (snap.components || []).forEach(function (c) { (byRecipe[c.recipe_id] = byRecipe[c.recipe_id] || []).push(c); });

  // Bottom-up order: a recipe after every sub-recipe it uses. Loops are errors.
  var order = [], state = {};
  function visit(id, path) {
    if (state[id] === 2) return;
    if (state[id] === 1) { errors.push('loop: ' + path.concat(id).map(function (x) { return (rec[x] || {}).name || x; }).join(' → ')); return; }
    state[id] = 1;
    (byRecipe[id] || []).forEach(function (c) { if (c.sub_recipe_id) visit(c.sub_recipe_id, path.concat(id)); });
    state[id] = 2; order.push(id);
  }
  Object.keys(rec).forEach(function (id) { visit(id, []); });

  var newCost = {};      // recipe id → new cost_per_yield_unit (used by parents)
  var compUpdates = [], recUpdates = [], driversFor = {};
  order.forEach(function (rid) {
    var r = rec[rid]; if (!r) return;
    var total = 0, drivers = [];
    (byRecipe[rid] || []).forEach(function (c) {
      var q = num(c.quantity), uc, srcUnit, label, srcName;
      if (c.ingredient_id) {
        var i = ing[c.ingredient_id];
        if (!i) { errors.push(r.name + ': component "' + c.name + '" points at a missing ingredient'); return; }
        uc = num(i.last_cost); srcUnit = i.unit; srcName = i.name;
        if (uc === null) { errors.push(r.name + ': ' + i.name + ' has no last_cost'); return; }
      } else if (c.sub_recipe_id) {
        var s = rec[c.sub_recipe_id];
        if (!s) { errors.push(r.name + ': component "' + c.name + '" points at a missing sub-recipe'); return; }
        uc = newCost[s.id]; srcUnit = s.yield_unit; srcName = s.name;
        if (uc === undefined || uc === null) { errors.push(r.name + ': sub-recipe ' + s.name + ' has no cost'); return; }
      } else { errors.push(r.name + ': component "' + c.name + '" has no ingredient or sub-recipe'); return; }
      if (q === null) { errors.push(r.name + ': component "' + c.name + '" has no quantity'); return; }
      if (String(c.unit) !== String(srcUnit)) {
        errors.push(r.name + ': "' + c.name + '" is in ' + c.unit + ' but ' + srcName + ' is costed per ' + srcUnit +
          ' — convert (each_weight / density) before costing');
        return;
      }
      var lc = r4(q * uc);
      total += lc;
      var oldUc = num(c.unit_cost);
      if (moved(oldUc, uc) || moved(num(c.line_cost), lc)) {
        var props = { unit_cost: r4(uc), line_cost: lc };
        var cm = String(c.cost_math || '');
        // Function replacers only: a price like "$16.04" in a replacement STRING
        // is read as back-reference $1 + "6.04".
        cm = cm.replace(/×\s*\$[\d.]+(\s+per)/, function (m, g1) { return '× ' + d4(uc) + g1; })
          .replace(/=\s*\$[\d.,]+\s*$/, function () { return '= ' + d4(lc); });
        if (c.sub_recipe_id) {
          var batch = d4(r4(newCost['__total_' + c.sub_recipe_id]));
          cm = cm.replace(/\$[\d.]+(\s+batch\s+÷)/, function (m, g1) { return batch + g1; });
        } else if (snap.cost_source) {
          cm = cm.replace(/(last cost\s+—\s+)[^;,)]+/, function (m, g1) { return g1 + snap.cost_source; });
        }
        props.cost_math = cm;
        if (c.name) props.name = String(c.name).replace(/\$[\d.]+\s*$/, function () { return d2(lc); });
        compUpdates.push({ id: c.id, title: c.name, properties: props });
        if (oldUc !== null && moved(oldUc, uc)) {
          drivers.push(srcName + ' ' + d4(oldUc) + ' → ' + d4(uc) + '/' + srcUnit + ' (' + signed(pct(uc, oldUc), 1) + '%)');
        }
      }
    });
    total = r4(total);
    var y = num(r.yield_quantity);
    if (!(y > 0)) { errors.push(r.name + ': yield_quantity must be > 0'); return; }
    var cpy = r4(total / y);
    newCost[rid] = cpy; newCost['__total_' + rid] = total;
    driversFor[rid] = drivers;
    var mp = num(r.menu_price), f = mp ? r1(cpy / mp * 100) : null;
    var rp = {};
    if (moved(num(r.total_cost), total)) rp.total_cost = total;
    if (moved(num(r.cost_per_yield_unit), cpy)) rp.cost_per_yield_unit = cpy;
    if (f !== null && (num(r.food_cost_pct) === null || Math.abs(num(r.food_cost_pct) - f) >= 0.05)) rp.food_cost_pct = f;
    if (Object.keys(rp).length) recUpdates.push({ id: rid, title: r.name, properties: rp });
  });

  // History: one new row per recipe whose cost per yield unit moved vs its latest snapshot.
  var latest = {};
  (snap.history || []).forEach(function (h) {
    var k = h.recipe_id, cur = latest[k];
    var key = String(h.costed_on || '') + '|' + String(h.created_at || '');
    if (!cur || key > cur.__key) latest[k] = Object.assign({ __key: key }, h);
  });
  var histCreates = [], report = [];
  order.forEach(function (rid) {
    var r = rec[rid]; if (!r || newCost[rid] === undefined) return;
    var cpy = newCost[rid], total = newCost['__total_' + rid], prev = latest[rid];
    var mp = num(r.menu_price), f = mp ? r1(cpy / mp * 100) : null;
    var isBaseline = !prev;
    var pfPrev = prev ? num(prev.food_cost_pct) : null;
    var priceMoved = prev && f !== null && (pfPrev === null || Math.abs(pfPrev - f) >= 0.05);
    if (!isBaseline && !moved(num(prev.cost_per_yield_unit), cpy) && !priceMoved) return;
    var unitLbl = r.yield_unit === 'portion' ? '' : '/' + r.yield_unit;
    var name = r.name + ' · ' + snap.costed_on + ' · ' + (r.yield_unit === 'portion' ? d2(cpy) : d4(cpy) + unitLbl) +
      (f !== null ? ' · ' + f.toFixed(1) + '%' : '');
    var p = { name: name, recipe_id: rid, trigger: isBaseline ? 'baseline' : snap.trigger, costed_on: snap.costed_on,
      total_cost: total, yield_quantity: num(r.yield_quantity), yield_unit: r.yield_unit, cost_per_yield_unit: cpy };
    if (snap.invoice_id) p.invoice_id = snap.invoice_id;
    if (mp) { p.menu_price = mp; p.food_cost_pct = f; }
    var alerts = [], line;
    if (isBaseline) {
      p.drivers = 'Baseline — first costing';
      line = r.name + ': baseline ' + d4(cpy) + unitLbl + (f !== null ? ' · ' + f.toFixed(1) + '%' : '');
    } else {
      var pc = num(prev.cost_per_yield_unit);
      if (prev.id) p.prev_snapshot_id = prev.id;
      p.prev_cost_per_yield_unit = pc;
      p.change_amount = r4(cpy - pc);
      p.change_pct = r1(pct(cpy, pc));
      var pf = num(prev.food_cost_pct);
      if (f !== null && pf !== null) p.food_cost_change_pts = r1(f - pf);
      var drv = (driversFor[rid] || []).slice();
      var pmp = num(prev.menu_price);
      if (mp && pmp !== null && Math.abs(pmp - mp) >= 0.005) drv.push('menu price ' + d2(pmp) + ' → ' + d2(mp));
      p.drivers = drv.join('; ') || 'recomputed (no single input moved)';
      line = r.name + ': ' + d4(pc) + ' → ' + d4(cpy) + unitLbl + ' (' + signed(p.change_pct, 1) + '%)' +
        (f !== null ? ' · food cost ' + (pf !== null ? pf.toFixed(1) + '% → ' : '') + f.toFixed(1) + '%' : '');
    }
    if (f !== null && f > ALERT_PCT) alerts.push('food cost ' + f.toFixed(1) + '% — over ' + ALERT_PCT + '%');
    if (p.food_cost_change_pts !== undefined && p.food_cost_change_pts >= ALERT_PTS) alerts.push(signed(p.food_cost_change_pts, 1) + ' pts in one re-cost');
    if (alerts.length) { p.alert = alerts.join('; '); line += '  ⚠ ' + p.alert; }
    histCreates.push({ title: name, properties: p });
    report.push(line);
  });
  return {
    order: order.map(function (id) { return (rec[id] || {}).name || id; }),
    component_updates: compUpdates, recipe_updates: recUpdates, history_creates: histCreates,
    report: report, errors: errors,
  };
}

function selfTest() {
  var assert = require('assert');
  var base = {
    trigger: 'invoice', invoice_id: 'inv2', costed_on: '2023-07-03', cost_source: 'US Foods 2023-07-03',
    ingredients: [
      { id: 'aru', name: 'Baby Arugula', unit: 'oz', last_cost: 0.3005 },
      { id: 'gar', name: 'Garlic, Peeled', unit: 'oz', last_cost: 0.2522 },
      { id: 'oil', name: 'Extra Virgin Olive Oil', unit: 'fl oz', last_cost: 0.3744 },
    ],
    recipes: [
      { id: 'gc', name: 'Garlic Confit', is_prep: true, yield_quantity: 40, yield_unit: 'fl oz', total_cost: 15.996, cost_per_yield_unit: 0.3999 },
      { id: 'sal', name: 'Salad', is_prep: false, yield_quantity: 1, yield_unit: 'portion', total_cost: 1.2879, cost_per_yield_unit: 1.2879, menu_price: 13, food_cost_pct: 9.9 },
    ],
    components: [
      { id: 'c1', recipe_id: 'gc', ingredient_id: 'gar', quantity: 16, unit: 'oz', unit_cost: 0.2522, line_cost: 4.0352,
        name: 'Garlic, Peeled · 16 oz · $4.04', cost_math: '16 oz × $0.2522 per oz (Garlic, Peeled last cost — US Foods 2023-06-26) = $4.0352' },
      { id: 'c2', recipe_id: 'gc', ingredient_id: 'oil', quantity: 32, unit: 'fl oz', unit_cost: 0.3744, line_cost: 11.9808,
        name: 'Extra Virgin Olive Oil · 32 fl oz · $11.98', cost_math: '32 fl oz × $0.3744 per fl oz (Extra Virgin Olive Oil last cost — US Foods 2023-06-26) = $11.9808' },
      { id: 'c3', recipe_id: 'sal', ingredient_id: 'aru', quantity: 3, unit: 'oz', unit_cost: 0.3005, line_cost: 0.9015,
        name: 'Baby Arugula · 3 oz · $0.90', cost_math: '3 oz × $0.3005 per oz (Baby Arugula last cost — US Foods 2023-06-26) = $0.9015' },
      { id: 'c4', recipe_id: 'sal', sub_recipe_id: 'gc', quantity: 1, unit: 'fl oz', unit_cost: 0.4011, line_cost: 0.4011,
        name: 'Garlic Confit (prep) · 1 fl oz · $0.40', cost_math: '1 fl oz × $0.4011 per fl oz (Garlic Confit prep: $16.0430 batch ÷ 40 fl oz yield) = $0.4011' },
    ],
    history: [
      { recipe_id: 'gc', costed_on: '2023-06-26', cost_per_yield_unit: 0.4004 },
      { id: 'h-sal', recipe_id: 'sal', costed_on: '2023-06-26', cost_per_yield_unit: 1.3019, food_cost_pct: 10.0 },
    ],
  };
  // Steady state: recipes already match inputs → recipe totals update, no component change except sub-recipe cascade.
  var p0 = plan(base);
  assert.deepStrictEqual(p0.errors, []);
  assert.deepStrictEqual(p0.order, ['Garlic Confit', 'Salad']);
  // Garlic Confit total = 4.0352 + 11.9808 = 16.016 → 0.4004/fl oz; salad's confit line was 0.4011 → 0.4004.
  assert.strictEqual(p0.component_updates.length, 1);
  assert.strictEqual(p0.component_updates[0].properties.unit_cost, 0.4004);
  assert.ok(/\$16\.0160 batch ÷/.test(p0.component_updates[0].properties.cost_math));
  assert.strictEqual(p0.history_creates.length, 0, 'gc 0.4004 = latest snapshot; salad 0.9015+0.4004 = 1.3019 = latest');
  // Arugula price rise cascades to the salad only.
  var s1 = JSON.parse(JSON.stringify(base)); s1.ingredients[0].last_cost = 0.3359;
  var p1 = plan(s1);
  var sal = p1.history_creates.filter(function (h) { return h.properties.recipe_id === 'sal'; })[0];
  assert.ok(sal, 'salad snapshot');
  assert.strictEqual(sal.properties.cost_per_yield_unit, r4(r4(3 * 0.3359) + 0.4004));
  assert.ok(/Baby Arugula \$0\.3005 → \$0\.3359\/oz/.test(sal.properties.drivers));
  assert.strictEqual(sal.properties.prev_snapshot_id, 'h-sal', 'links the snapshot it was compared against');
  assert.ok(/US Foods 2023-07-03/.test(p1.component_updates.filter(function (c) { return c.id === 'c3'; })[0].properties.cost_math));
  assert.strictEqual(p1.history_creates.filter(function (h) { return h.properties.recipe_id === 'gc'; }).length, 0);
  // Garlic rise cascades through the confit into the salad.
  var s2 = JSON.parse(JSON.stringify(base)); s2.ingredients[1].last_cost = 0.40;
  var p2 = plan(s2);
  assert.strictEqual(p2.history_creates.length, 2);
  // A price starting with "$1" survives the rewrite (the back-reference trap).
  var s7 = JSON.parse(JSON.stringify(base)); s7.ingredients[1].last_cost = 1.05;
  var c1 = plan(s7).component_updates.filter(function (c) { return c.id === 'c1'; })[0].properties;
  assert.ok(/16 oz × \$1\.0500 per oz .* = \$16\.8000$/.test(c1.cost_math), c1.cost_math);
  assert.ok(/· \$16\.80$/.test(c1.name), c1.name);
  // Alert when food cost passes 30%.
  var s3 = JSON.parse(JSON.stringify(base)); s3.recipes[1].menu_price = 4;
  var p3 = plan(s3);
  var salAlert = p3.history_creates.filter(function (h) { return h.properties.recipe_id === 'sal'; })[0];
  assert.ok(salAlert && /over 30%/.test(salAlert.properties.alert || ''), 'menu price drop → food cost over 30% → alert row');
  assert.strictEqual(salAlert.properties.change_amount, 0, 'cost unchanged; only the price moved');
  // Unit mismatch and loops are errors.
  var s4 = JSON.parse(JSON.stringify(base)); s4.components[2].unit = 'lb';
  assert.ok(plan(s4).errors.some(function (e) { return /costed per oz/.test(e); }));
  var s5 = JSON.parse(JSON.stringify(base));
  s5.components.push({ id: 'c5', recipe_id: 'gc', sub_recipe_id: 'sal', quantity: 1, unit: 'portion', name: 'x' });
  assert.ok(plan(s5).errors.some(function (e) { return /^loop/.test(e); }));
  // No history yet → baseline rows.
  var s6 = JSON.parse(JSON.stringify(base)); s6.history = [];
  assert.ok(plan(s6).history_creates.every(function (h) { return h.properties.trigger === 'baseline'; }));
  console.log('recost self-test: ok');
}

if (require.main === module) {
  if (process.argv[2] === '--self-test') { selfTest(); process.exit(0); }
  var file = process.argv[2];
  if (!file) { console.error('usage: node recost.cjs <snapshot.json> | --self-test'); process.exit(2); }
  var snap = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  process.stdout.write(JSON.stringify(plan(snap), null, 2) + '\n');
}

module.exports = { plan: plan, ALERT_PCT: ALERT_PCT, ALERT_PTS: ALERT_PTS };
