import test from 'node:test';
import assert from 'node:assert/strict';
import { families, familyTemplate } from '../lib/families.mjs';
import { validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { serves } from '../lib/tool-catalog.mjs';

// A workflow created from a template must be able to do everything its family offers:
// a missing slot silently removes a verb (a MiniMax workflow without a source video slot
// cannot continue a clip, so the router sends continuations to another model).
test('every family template has a slot for each role and serves each of its verbs', () => {
  for (const manifest of Object.values(families())) {
    const template = familyTemplate(manifest);
    const components = Object.fromEntries(
      Object.keys(manifest.components).map(role => [role, { policy: 'fixed', asset: role }]),
    );
    const workflow = validateNativeWorkflow({ ...template, enabled: true, name: manifest.label, components });
    const roles = new Set(workflow.references.map(slot => slot.role));
    for (const role of Object.keys(manifest.roles))
      assert.ok(roles.has(role), `${manifest.family} template lacks a ${role} slot`);
    for (const verb of manifest.tasks)
      assert.ok(serves(workflow, verb), `${manifest.family} template cannot serve ${verb}`);
  }
});
