#!/usr/bin/env node
'use strict';
// IS: The kitchen skills' write checker — re-does the per-row arithmetic on
//     every row the restaurant MCP just wrote (`create_row` / `update_row` /
//     `upsert_row`, and every create / update / upsert inside a `write_rows`
//     batch, on invoice_lines, vendor_items, ingredients, recipes,
//     recipe_lines, decisions) and hands any mismatch back to the model as a
//     blocking reason. Wired as a PostToolUse hook on
//     `mcp__.*__(create_row|update_row|upsert_row|write_rows)` (the restaurant
//     repo's agent job wires it; .claude/settings.json can too). Reads the
//     Claude Code hook JSON on stdin and checks only the stored rows the tool
//     returned (`{ "row": … }`, or a batch's `{ "results": [{ "row": … }, …] }`
//     paired with its `writes` by index), so it needs no network and no
//     credential. A refused batch rolled back whole and returns no rows —
//     nothing to check.
// IS NOT: A gate on the MCP itself (the write has already landed — the model
//     fixes it), a cross-row check (links and the invoice-total close are the
//     skill's read-back steps), or a cost check: costs are the restaurant
//     database's views and no table stores one.
//
// Exit 0 always. A problem is reported as {"decision":"block","reason":…}.
// `node check-write.cjs --self-test` runs the built-in cases.

// One `each` of a pack in the ingredient's base unit, by the pack's each-unit.
var TO_OZ = { oz: 1, lb: 16, g: 0.035274, kg: 35.274 };
var TO_FLOZ = { 'fl oz': 1, l: 33.814, ml: 0.033814, gal: 128, qt: 32, pt: 16 };
var BASE_UNITS = ['oz', 'fl oz', 'each'];

// Postgres numerics arrive as strings; an empty value is null.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : null;
}
function close(a, b, rel, abs) { return Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel); }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o || {}, k); }

// base_units_per_case from the pack alone, when the pack and the base unit are the same kind.
function expectedBasePerCase(row) {
  var count = num(row.pack_count), size = num(row.pack_each_size);
  var unit = String(row.pack_each_unit || '').toLowerCase().trim();
  if (count === null || size === null) return null;
  if (row.base_unit === 'oz' && TO_OZ[unit]) return count * size * TO_OZ[unit];
  if (row.base_unit === 'fl oz' && TO_FLOZ[unit]) return count * size * TO_FLOZ[unit];
  return null;
}

function checkInvoiceLine(row, written, created, problems) {
  ['invoice_id', 'description', 'quantity', 'unit', 'unit_price', 'total_cost'].forEach(function (k) {
    if (created && (row[k] === null || row[k] === undefined || row[k] === '')) problems.push('`' + k + '` is empty');
  });
  // Only when a price or quantity was written: mapping a line (vendor_item_id) never re-judges its arithmetic,
  // so a line the owner accepted at its printed total stays as printed.
  if (!['quantity', 'unit_price', 'total_cost'].some(function (k) { return has(written, k); })) return;
  var q = num(row.quantity), p = num(row.unit_price), t = num(row.total_cost);
  if (q !== null && p !== null && t !== null && !close(q * p, t, 0, 0.011)) {
    problems.push('quantity × unit_price = $' + (q * p).toFixed(2) + ' but total_cost is $' + t.toFixed(2) +
      ' — fix the line, or (if the paper really prints it so) keep it as printed and park a `reconcile` decision for it');
  }
}

function checkVendorItem(row, written, created, problems) {
  if (has(written, 'verified') && written.verified !== false) problems.push('`verified` is the owner\'s tick — never set it true');
  if (has(written, 'verified_by')) problems.push('`verified_by` is the owner\'s — never write it');
  if (created && row.verified !== false && row.verified !== 'false') problems.push('a new vendor item starts `verified` false');
  if (row.base_unit !== null && row.base_unit !== undefined && BASE_UNITS.indexOf(row.base_unit) < 0) {
    problems.push('`base_unit` "' + row.base_unit + '" is not oz, fl oz or each');
  }
  var bpc = num(row.base_units_per_case);
  if (row.ingredient_id && bpc === null) problems.push('mapped to an ingredient but `base_units_per_case` is empty');
  var expected = expectedBasePerCase(row);
  if (bpc !== null && expected !== null && !close(bpc, expected, 0.005, 0.01)) {
    problems.push('the pack (' + row.pack_count + ' × ' + row.pack_each_size + ' ' + row.pack_each_unit + ') is ' +
      +expected.toFixed(4) + ' ' + row.base_unit + ' but `base_units_per_case` is ' + bpc);
  }
}

function checkIngredient(row, problems) {
  if (BASE_UNITS.indexOf(row.unit) < 0) problems.push('`unit` "' + row.unit + '" is not oz, fl oz or each');
  var ew = num(row.each_weight_oz);
  if (ew !== null && !(ew > 0)) problems.push('`each_weight_oz` must be more than 0 (or empty, never guessed)');
  var d = num(row.density_oz_per_floz);
  if (d !== null && !(d > 0)) problems.push('`density_oz_per_floz` must be more than 0 (or empty)');
}

function checkRecipe(row, problems) {
  var yq = num(row.yield_quantity);
  if (!(yq > 0)) problems.push('`yield_quantity` must be more than 0');
  var isPrep = row.is_prep === true || row.is_prep === 'true';
  if (isPrep && num(row.menu_price) !== null) problems.push('a prep recipe has no `menu_price`');
  if (!isPrep && (yq !== 1 || row.yield_unit !== 'portion')) problems.push('a menu dish yields `1` `portion`');
}

function checkRecipeLine(row, problems) {
  var q = num(row.quantity);
  if (!(q > 0)) problems.push('`quantity` must be more than 0 — a line with no real amount is asked about, not written');
}

function checkDecision(row, created, problems) {
  if (!String(row.title || '').trim()) problems.push('a decision needs a `title` the owner can read');
  if (!String(row.notes || '').trim()) problems.push('a decision\'s `notes` say what is proposed, what it blocks and what clears it');
  if (created && row.status !== 'open') problems.push('a parked decision starts `open`');
  if (['new_product', 'each_weight', 'reconcile'].indexOf(row.kind) >= 0 && !row.invoice_id) {
    problems.push('a `' + row.kind + '` decision names its `invoice_id`');
  }
}

// One stored row → its problems, each prefixed with the table and id.
function checkRow(table, row, written, created) {
  var problems = [];
  switch (table) {
    case 'invoice_lines': checkInvoiceLine(row, written, created, problems); break;
    case 'vendor_items': checkVendorItem(row, written, created, problems); break;
    case 'ingredients': checkIngredient(row, problems); break;
    case 'recipes': checkRecipe(row, problems); break;
    case 'recipe_lines': checkRecipeLine(row, problems); break;
    case 'decisions': checkDecision(row, created, problems); break;
    default: return [];
  }
  return problems.map(function (p) { return table + ' ' + (row.id || '') + ': ' + p; });
}

// An upsert writes `match` ∪ `values` when it creates, only `values` when it updates.
function writtenBy(op, write, created) {
  var values = write.values || {};
  return op === 'upsert' && created ? Object.assign({}, write.match || {}, values) : values;
}
function createdBy(op, result) {
  return op === 'create' || (op === 'upsert' && !!(result && (result.created === true || result.created === 'true')));
}

// The hook payload → a list of problems (empty when every stored row is right).
function check(payload) {
  var name = String(payload.tool_name || '');
  var m = name.match(/(create_row|update_row|upsert_row|write_rows)$/);
  if (!m) return [];
  var input = payload.tool_input || {};
  var resp = payload.tool_response;
  if (Array.isArray(resp)) resp = resp.map(function (b) { return b && b.text; }).join('');
  if (resp && typeof resp === 'object' && Array.isArray(resp.content)) resp = resp.content.map(function (b) { return b && b.text; }).join('');
  var body;
  try { body = typeof resp === 'string' ? JSON.parse(resp) : resp; } catch (e) { return []; }
  if (!body || typeof body !== 'object') return [];
  if (m[1] === 'write_rows') {
    var writes = Array.isArray(input.writes) ? input.writes : [];
    var results = Array.isArray(body.results) ? body.results : [];
    var out = [];
    writes.forEach(function (w, i) {
      var op = w && w.op;
      if (['create', 'update', 'upsert'].indexOf(op) < 0) return;
      var r = results[i];
      var row = r && r.row;
      if (!row || typeof row !== 'object') return;
      var created = createdBy(op, r);
      checkRow(w.table, row, writtenBy(op, w, created), created).forEach(function (p) {
        out.push('write ' + i + ' (' + op + ') ' + p);
      });
    });
    return out;
  }
  var row = body.row;
  if (!row || typeof row !== 'object') return [];
  var op = m[1].replace('_row', '');
  var created = createdBy(op, body);
  return checkRow(input.table, row, writtenBy(op, input, created), created);
}

function selfTest() {
  var assert = require('assert');
  function call(tool, table, values, row) {
    return { tool_name: 'mcp__restaurant__' + tool, tool_input: { table: table, values: values },
      tool_response: [{ type: 'text', text: JSON.stringify({ row: Object.assign({ id: 'r1' }, row) }) }] };
  }
  var line = { invoice_id: 'i', description: 'PARMESAN SHAVED', quantity: '2', unit: 'CS', unit_price: '41.21', total_cost: '82.42' };
  assert.deepStrictEqual(check(call('create_row', 'invoice_lines', line, line)), [], 'a reconciled line passes');
  var off = Object.assign({}, line, { total_cost: '80.00' });
  assert.strictEqual(check(call('create_row', 'invoice_lines', off, off)).length, 1, 'q × p ≠ total blocks');
  assert.deepStrictEqual(check(call('update_row', 'invoice_lines', { vendor_item_id: 'v' }, off)), [], 'mapping an accepted line does not re-judge it');
  var vi = { vendor_id: 'v', ingredient_id: 'g', pack_count: '4', pack_each_size: '5', pack_each_unit: 'LB', base_unit: 'oz', base_units_per_case: '320', verified: false };
  assert.deepStrictEqual(check(call('create_row', 'vendor_items', vi, vi)), [], '4/5 LB = 320 oz passes');
  assert.strictEqual(check(call('create_row', 'vendor_items', vi, Object.assign({}, vi, { base_units_per_case: '80' }))).length, 1, 'a wrong conversion blocks');
  assert.strictEqual(check(call('update_row', 'vendor_items', { verified: true }, Object.assign({}, vi, { verified: true }))).length, 1, 'the model never ticks verified');
  var cnt = Object.assign({}, vi, { pack_count: '12', pack_each_size: '1', pack_each_unit: 'clamshell', base_units_per_case: '72' });
  assert.deepStrictEqual(check(call('create_row', 'vendor_items', cnt, cnt)), [], 'a count pack by each weight is the skill\'s to show, not the checker\'s');
  assert.strictEqual(check(call('create_row', 'ingredients', {}, { unit: 'lb' })).length, 1, 'base unit must be oz / fl oz / each');
  assert.strictEqual(check(call('create_row', 'recipes', {}, { is_prep: false, yield_quantity: '1', yield_unit: 'portion', menu_price: '14.00' })).length, 0, 'a menu dish passes');
  assert.strictEqual(check(call('create_row', 'recipes', {}, { is_prep: true, yield_quantity: '40', yield_unit: 'fl oz', menu_price: '3' })).length, 1, 'a prep has no price');
  assert.strictEqual(check(call('create_row', 'recipe_lines', {}, { quantity: '0' })).length, 1, 'no zero quantities');
  var dec = { invoice_id: 'i', kind: 'each_weight', title: 'Each weight needed: Blackberries', notes: 'Blocks line 4; clears with a weight in oz.', status: 'open' };
  assert.deepStrictEqual(check(call('create_row', 'decisions', dec, dec)), [], 'a parked decision passes');
  assert.strictEqual(check(call('create_row', 'decisions', {}, Object.assign({}, dec, { invoice_id: null }))).length, 1, 'an invoice decision names its invoice');
  assert.deepStrictEqual(check({ tool_name: 'mcp__x__list_rows', tool_input: { table: 'invoice_lines' }, tool_response: '{}' }), [], 'reads are ignored');
  assert.deepStrictEqual(check(call('create_row', 'invoices', {}, {})), [], 'tables with no rules pass');

  // upsert_row: created → match ∪ values were written; updated → only values.
  function upsert(table, match, values, row, created) {
    return { tool_name: 'mcp__restaurant__upsert_row', tool_input: { table: table, match: match, values: values },
      tool_response: [{ type: 'text', text: JSON.stringify({ row: Object.assign({ id: 'r1' }, row), created: created }) }] };
  }
  assert.deepStrictEqual(check(upsert('vendor_items', { vendor_id: 'v', item_code: '7929170' }, vi, vi, true)), [], 'an upserted new vendor item passes');
  assert.strictEqual(check(upsert('vendor_items', { vendor_id: 'v', item_code: '7929170' }, {}, Object.assign({}, vi, { verified: true }), true)).length, 1, 'an upsert that creates starts unverified');
  assert.deepStrictEqual(check(upsert('vendor_items', { vendor_id: 'v', item_code: '7929170' }, { description: 'x' }, Object.assign({}, vi, { verified: true }), false)), [], 'an upsert that updates leaves the owner\'s tick alone');

  // write_rows: every create / update / upsert is checked against its own result, by index.
  function batch(writes, results) {
    return { tool_name: 'mcp__restaurant__write_rows', tool_input: { writes: writes },
      tool_response: [{ type: 'text', text: JSON.stringify({ results: results }) }] };
  }
  var inv = { id: 'i', vendor_id: 'v', invoice_no: '123', invoice_total: '164.84' };
  var line2 = Object.assign({}, line, { id: 'l2', description: 'PARMESAN GRATED' });
  var good = [
    { op: 'create', table: 'invoices', id: 'i', values: inv },
    { op: 'create', table: 'invoice_lines', values: line },
    { op: 'create', table: 'invoice_lines', values: line2 },
    { op: 'update', table: 'invoice_lines', id: 'l2', values: { vendor_item_id: 'vi' } },
    { op: 'create', table: 'decisions', values: dec },
  ];
  var goodResults = [{ row: inv }, { row: Object.assign({ id: 'l1' }, line) }, { row: line2 },
    { row: Object.assign({}, line2, { vendor_item_id: 'vi' }) }, { row: Object.assign({ id: 'd1' }, dec) }];
  assert.deepStrictEqual(check(batch(good, goodResults)), [], 'a good batch passes');
  var bad = good.slice(); bad[2] = { op: 'create', table: 'invoice_lines', values: off };
  var badResults = goodResults.slice(); badResults[2] = { row: Object.assign({ id: 'l2' }, off) };
  var found = check(batch(bad, badResults));
  assert.strictEqual(found.length, 1, 'one bad write in a good batch blocks, alone');
  assert.ok(/^write 2 \(create\) invoice_lines l2: /.test(found[0]), 'the problem names the write\'s index: ' + found[0]);
  assert.strictEqual(check(batch([{ op: 'upsert', table: 'recipes', match: { name: 'Soup' }, values: {} }],
    [{ row: { id: 'r', is_prep: false, yield_quantity: '2', yield_unit: 'portion' }, created: true }])).length, 1, 'an upsert inside a batch is checked');
  assert.deepStrictEqual(check(batch([{ op: 'delete', table: 'recipe_lines', id: 'x' }], [{ deleted: 'x' }])), [], 'a delete has no row to check');
  assert.deepStrictEqual(check({ tool_name: 'mcp__restaurant__write_rows', tool_input: { writes: good },
    tool_response: [{ type: 'text', text: 'write 2 refused: …; nothing was written' }] }), [], 'a refused batch rolled back — nothing to check');
  console.log('check-write: self-test passed');
}

if (require.main === module) {
  if (process.argv[2] === '--self-test') { selfTest(); process.exit(0); }
  var buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (c) { buf += c; });
  process.stdin.on('end', function () {
    var payload;
    try { payload = JSON.parse(buf || '{}'); } catch (e) { process.exit(0); }
    var problems = check(payload);
    if (problems.length) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: 'The stored row does not check out — fix it before moving on:\n- ' + problems.join('\n- '),
      }) + '\n');
    }
    process.exit(0);
  });
}

module.exports = { check: check };
