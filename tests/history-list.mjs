import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
class Element {
  children = []; dataset = {}; attributes = {}; disabled = false; hidden = false;
  constructor(tag, className = '', text = '') { this.tag = tag; this.className = className; this.textContent = text; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  focus() { this.focused = true; }
  close() { this.closed = true; }
}
async function fixture(state) {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element('div')]));
  nodes.get('conversation-title').textContent = 'Current conversation';
  const calls = [];
  const context = { state, $: id => { assert.ok(nodes.has(id), 'Missing real element ' + id); return nodes.get(id); }, node: (tag, name, text) => new Element(tag, name, text), icon: name => new Element('svg', name), loadConversation: id => calls.push(['open', id]), confirmHistoryDeletion: item => calls.push(['delete', item.id]) };
  const render = source.slice(source.indexOf('function renderHistory()'), source.indexOf('async function refreshHistory()'));
  runInNewContext(render + '\nrenderHistory();', context);
  return { nodes, calls };
}
const past = { id: 'past', title: 'Earlier conversation', updatedAt: '2026-11-07T10:00:00.000Z' };
const current = { id: 'current', title: 'Current conversation', updatedAt: '2026-11-08T10:00:00.000Z' };
test('one shared stack shows the current conversation first without a duplicate saved row', async () => {
  const { nodes, calls } = await fixture({ saveHistory: true, conversationId: 'current', historyItems: [past, current], status: {} });
  for (const id of ['history-list', 'history-list-mobile']) {
    const rows = nodes.get(id).children;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].children[0].dataset.conversationId, 'current');
    assert.equal(rows[0].children[0].attributes['aria-current'], 'page');
    assert.equal(rows[1].children[0].dataset.conversationId, 'past');
    assert.equal(rows[1].children[0].attributes['aria-current'], undefined);
    rows[1].children[0].onclick(); rows[0].children[1].onclick();
  }
  assert.deepEqual(calls, [['open','past'],['delete','current'],['open','past'],['delete','current']]);
});
test('a new or unsaved conversation still has a current row when history is disabled', async () => {
  const { nodes } = await fixture({ saveHistory: false, conversationId: null, historyItems: [], status: {} });
  assert.equal(nodes.get('history-section').hidden, false);
  const rows = nodes.get('history-list').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[0].attributes['aria-current'], 'page');
  assert.equal(rows[0].children.length, 1);
});
