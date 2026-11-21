import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
/** The declarations of the rule written exactly with `selector`. */
function rule(selector) {
  const at = css.indexOf('\n' + selector + ' {\n');
  assert.ok(at >= 0, 'no rule ' + selector);
  return css.slice(at, css.indexOf('\n}', at + 1));
}

test('Générer: dark, its triangle and word centred, 46 px, 8 px corners (moodix-design.md 7 bis 22)', () => {
  const go = rule('#studio-view .studio-go');
  for (const declaration of [
    'min-width: 170px;',
    'height: calc(var(--format-button) + 2 * var(--format-inset));',
    'padding: 0 20px;',
    'border: 1px solid #2e323c;',
    'border-radius: 8px;',
    'background: #1c1f26;',
    'color: #ffffff;',
    'font-weight: 800;',
    'font-size: var(--size-4);',
    'justify-content: center;',
    'gap: 10px;',
  ])
    assert.ok(go.includes(declaration), declaration);
  const glyph = rule('#studio-view .studio-go svg');
  assert.match(glyph, /width: 14px;[^]*height: 14px;[^]*fill: currentColor;/);
  // No red band, no « Ctrl ↵ », no brightness on hover, no 40 % greying.
  assert.doesNotMatch(css, /studio-go-key/);
  assert.doesNotMatch(css, /\.studio-go[^{]*\{[^}]*(--fn-action|brightness|opacity: 0\.4)/);
});

test('its foot: the gradient of the filet, fixed, over all', () => {
  assert.match(css, /--mdx-gradient: linear-gradient\(90deg, #3d6bf5 19%, #22a060 47\.6%, #f6c343 71\.4%, #e8402f 92\.9%\);/);
  const foot = rule('#studio-view .studio-go::before');
  assert.match(foot, /bottom: 0;[^]*left: 0;[^]*z-index: 2;[^]*height: 3px;[^]*background: var\(--mdx-gradient\);/);
  assert.doesNotMatch(foot, /animation/);
});

test('hovered or focused, unavailable, under way, and in the light theme', () => {
  assert.match(rule('#studio-view .studio-go:is(:hover, :focus-visible):enabled'), /background: #252932;[^]*border-color: #3a3f4a;/);
  assert.match(rule('#studio-view .studio-go:focus-visible'), /outline: 2px solid var\(--focus\);/);
  const dim = rule("#studio-view .studio-go.is-unavailable,\n#studio-view .studio-go:disabled:not([role='progressbar'])");
  assert.match(dim, /background: #121318;[^]*border-color: #22252c;[^]*color: var\(--text-4\);/);
  assert.match(css, /#studio-view \.studio-go:disabled:not\(\[role='progressbar'\]\)::before \{\n {2}display: none;/);
  // (0.6.186, measured in the page on 21/11) In the group of the Salle obscure its words stayed lit when it
  // was greyed for a model that cannot run here or for a creation made elsewhere: the rule of the group
  // comes after the one above and is as precise. What cannot be pressed dims its words there, after it.
  const held = "#studio-view .studio-go-group .studio-go:disabled:not([role='progressbar']) :is(.studio-go-label, svg)";
  assert.match(
    rule('#studio-view .studio-go.is-blank,\n#studio-view .studio-go-group .studio-go.is-blank :is(.studio-go-label, svg),\n' + held),
    /color: rgba\(238, 232, 222, 0\.45\);/,
  );
  assert.ok(css.indexOf(held) > css.indexOf('#studio-view .studio-go-group:not(.is-checking) .studio-go {'), 'after the rule of the group');
  // Under way: the bar fills the whole height from the left, under the words; mono 14 px.
  assert.match(rule('.studio-go-bar'), /top: 0;[^]*bottom: 0;[^]*z-index: 0;[^]*width: calc\(var\(--studio-progress, 0\) \* 100%\);[^]*background: #2c313b;/);
  assert.match(rule("#studio-view .studio-go[role='progressbar'] .studio-go-label"), /font-family: var\(--font-mono\);[^]*font-size: var\(--size-3\);[^]*font-weight: 600;/);
  assert.match(rule("#studio-view .studio-go[role='progressbar'] svg"), /display: none;/);
  assert.match(rule('#studio-view .studio-go:disabled'), /cursor: progress;/);
  // The light theme.
  assert.match(rule(":root[data-theme='light'] #studio-view .studio-go"), /border-color: #d5d9e0;[^]*background: #ffffff;[^]*color: var\(--text-1\);/);
  assert.match(rule(":root[data-theme='light'] #studio-view .studio-go:is(:hover, :focus-visible):enabled"), /border-color: #c3c8d0;[^]*background: #f1f3f6;/);
  assert.match(rule(":root[data-theme='light'] .studio-go-bar"), /background: #e3e6eb;/);
});
