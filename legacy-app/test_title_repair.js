'use strict';
// Independent, static/VM-only audit. Does not run app initialization or a browser.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const appPath = path.join(__dirname, 'web/app.js');
const htmlPath = path.join(__dirname, 'web/index.html');
const mapPath = path.join(root, 'outputs/巴菲特知识库/reader/data/title-repairs.js');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const originalHashes = [appPath, htmlPath, mapPath].map(p => ({path: path.relative(root, p), sha256: hash(p)}));
const app = fs.readFileSync(appPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8').replace(/^window\.KB_TITLE_REPAIRS=/, '').replace(/;\s*$/, ''));
const checks = [];
function check(id, fn) { fn(); checks.push({id, status: 'pass'}); }
const start = app.indexOf('  function sourceDisplayTitle(');
const end = app.indexOf('  function sourceDescription(', start);
assert(start >= 0 && end > start);
const context = vm.createContext({window: {KB_TITLE_REPAIRS: map}});
vm.runInContext("const text = value => typeof value === 'string' ? value : '';\n" + app.slice(start, end), context);
const display = source => context.sourceDisplayTitle(source);
check('node_syntax_current_app', () => cp.execFileSync(process.execPath, ['--check', appPath]));
check('all_actual_verified_title_mappings', () => {
  const mapBefore = JSON.stringify(map);
  for (const [id, entry] of Object.entries(map)) {
    assert.equal(entry.roundtrip_verified, true);
    const source = Object.freeze({id, title: entry.original_title, text: 'Original evidence text remains exact.'});
    const before = JSON.stringify(source);
    assert.equal(display(source), entry.reading_title, id);
    assert.equal(JSON.stringify(source), before, id + ': source mutation');
  }
  assert.equal(JSON.stringify(map), mapBefore);
});
const example = Object.values(map)[0];
check('map_absent_keeps_original', () => {
  context.window.KB_TITLE_REPAIRS = undefined;
  assert.equal(display({title: example.original_title}), example.original_title);
});
check('unknown_and_nonexact_titles_unchanged', () => {
  context.window.KB_TITLE_REPAIRS = map;
  assert.equal(display({title: 'Unmapped original title'}), 'Unmapped original title');
  assert.equal(display({title: example.original_title + ' '}), example.original_title + ' ');
});
check('strict_boolean_verification_required', () => {
  for (const flag of [false, 'true', 1, null, undefined]) {
    context.window.KB_TITLE_REPAIRS = {x: {...example, roundtrip_verified: flag}};
    assert.equal(display({title: example.original_title}), example.original_title);
  }
});
check('empty_or_nonstrings_rejected', () => {
  for (const reading_title of ['', null, 23, {}]) {
    context.window.KB_TITLE_REPAIRS = {x: {...example, reading_title}};
    assert.equal(display({title: example.original_title}), example.original_title);
  }
});
check('ambiguous_map_keeps_original', () => {
  context.window.KB_TITLE_REPAIRS = {x: example, y: {...example, reading_title: 'Conflicting repair'}};
  assert.equal(display({title: example.original_title}), example.original_title);
});
check('duplicate_same_repair_allowed', () => {
  context.window.KB_TITLE_REPAIRS = {x: example, y: {...example}};
  assert.equal(display({title: example.original_title}), example.reading_title);
});
check('missing_title_falls_back_to_id_without_throwing', () => {
  context.window.KB_TITLE_REPAIRS = map;
  assert.equal(display({id: 'source-01'}), 'source-01');
  assert.equal(display(undefined), '');
});
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const refs = [...new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))];
check('static_dom_id_references_resolve', () => {
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML ids');
  for (const id of refs) assert(ids.includes(id), 'missing DOM id: ' + id);
});
const scripts = [...html.matchAll(/<script\b([^>]*)><\/script>/g)].map(m => ({src: /src="([^"]+)"/.exec(m[1])?.[1], defer: /\bdefer\b/.test(m[1])}));
check('verified_map_loads_before_app', () => {
  assert.deepEqual(scripts, [{src: '/library/reader/data/title-repairs.js', defer: true}, {src: 'app.js', defer: true}]);
});
check('all_source_title_display_sites_use_helper', () => {
  assert(app.includes("source ? sourceDisplayTitle(source) : 'Source details unavailable'"));
  assert(app.includes('Read source ${number}: ${sourceDisplayTitle(source) || id}'));
  assert(app.includes("button = element('button', '', sourceDisplayTitle(source))"));
  assert(!/source\.title\s*=(?!=)/.test(app), 'canonical source title assignment');
});
check('root_presentation_followup_distinguishes_review_statuses', () => {
  assert(app.includes("model_checked_selected_passages: 'Experimental · checked against retrieved passages'"));
  assert(app.includes("scope_response: 'Experimental · scope check only'"));
  assert(app.includes("withheld: 'Experimental · draft withheld after checks'"));
  assert(app.includes('This response only checks the library’s scope. No source retrieval or factual answer review was performed.'));
});
for (let i = 0; i < originalHashes.length; i++) {
  const p = [appPath, htmlPath, mapPath][i];
  originalHashes[i].unchanged_during_review = originalHashes[i].sha256 === hash(p);
  assert(originalHashes[i].unchanged_during_review);
}
const report = {
  schema_version: 'qa-live-title-display-review-1.0',
  reviewed_at_utc: new Date().toISOString(),
  status: 'pass_scoped_static_and_helper_review',
  scope: 'Current title-display helper, existing exact-match verified title map, script ordering and static DOM references. Model engine, prompts, source corpus and answer semantics are outside this review.',
  files: originalHashes,
  title_map_entries_checked: Object.keys(map).length,
  html_unique_ids: ids.length,
  javascript_literal_dom_refs: refs.length,
  checks,
  findings: [],
  presentation_followup: {
    author: 'root',
    nature: 'Presentation-only review-status wording after the original frontend checks; distinct scope-only, withheld and selected-passage model-review labels are present.',
    checked_here: 'Static label branches and scope explanation only.',
    separate_browser_evidence: 'work/qa_live/browser-review.json',
    limitation: 'The browser report was read for coordination; its interaction results are not represented as this reviewer’s independent browser execution.'
  },
  invariants: ['Canonical source objects and IDs remain unchanged by the title helper.', 'Repairs require exact original_title equality and roundtrip_verified === true.', 'Absent, invalid, unverified, nonexact and conflicting mappings retain the original display title.', 'This helper does not modify evidence text or infer encoding repairs.'],
  limits: ['No real browser, model call or application initialization was run for this audit.', 'Static DOM checks verify unique IDs, literal references and scripts, not layout, accessibility behavior or runtime interaction.', 'This replaces neither the earlier broader frontend report nor the independent semantic/generation evaluation.'],
  no_product_files_modified: true,
  heldout_material_accessed: false
};
fs.writeFileSync(path.join(__dirname, 'title-repair-review.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({status: report.status, checks: checks.length, mappings: Object.keys(map).length, files: originalHashes}));
