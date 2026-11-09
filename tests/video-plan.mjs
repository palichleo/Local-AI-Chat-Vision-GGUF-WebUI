import test from 'node:test';
import assert from 'node:assert/strict';
import { renderVideoPlan } from '../public/video-plan.mjs';
const node = (tag, cls = '', text = '') => ({
  tag,
  textContent: text,
  children: [],
  append(...children) {
    this.children.push(...children);
  },
  replaceChildren(...children) {
    this.children = children;
  },
});
function text(element) {
  return [element.textContent, ...element.children.map(text)].join(' ');
}
test('computed video dimensions and cadence never masquerade as known numeric settings or duration', () => {
  const box = node('section');
  renderVideoPlan(
    box,
    {
      workflowName: 'User video',
      plan: {
        prompt: 'Move',
        intention: 'A draft',
        parameters: { width: ['size', 0], height: 512, frames: 81, fps: ['rate', 0], seed: ['random', 0] },
        defaultReferences: [{ input: 'start', name: 'Start frame' }],
      },
    },
    node,
  );
  const rendered = text(box);
  assert.doesNotMatch(rendered, /size,0 ×|Durée estimée|rate,0 i\/s|random,0/);
  assert.match(rendered, /Start frame/);
});
