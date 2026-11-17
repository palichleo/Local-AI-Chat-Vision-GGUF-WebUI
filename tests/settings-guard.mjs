import assert from 'node:assert/strict';
import test from 'node:test';
import { setupSettingsGuard } from '../public/settings-guard.mjs';

// The guard of the settings (settings-guard.mjs): what is unsaved is asked about before they close.
function element(page) {
  return {
    open: false,
    ownerDocument: page,
    listeners: {},
    addEventListener(name, fn) {
      (this.listeners[name] ??= []).push(fn);
    },
    emit(name, event = {}) {
      for (const fn of this.listeners[name] || []) fn(event);
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.emit('close');
    },
  };
}
/** The settings open in a page: its window hears the keys, `others` are the windows open over them. */
function settings({ withPage = true } = {}) {
  const others = [],
    view = element(),
    page = withPage ? { defaultView: view, querySelectorAll: () => [dialog, confirmation, ...others].filter(item => item.open) } : undefined,
    dialog = element(page),
    confirmation = element(page),
    keep = element(),
    discard = element(),
    saveButton = element();
  let draft = 'saved';
  const guard = setupSettingsGuard({ dialog, confirmation, keep, discard, saveButton, readDraft: () => draft, save: async () => true });
  dialog.showModal();
  guard.markSaved();
  /** Échap pressed with the focus in `where` (null: lost, the key goes to the page). */
  const press = (where, extra = {}) => {
    const event = {
      key: 'Escape',
      target: { closest: () => where },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    (withPage ? view : dialog).emit('keydown', event);
    return event.defaultPrevented;
  };
  return { guard, dialog, confirmation, keep, others, press, change: value => (draft = value) };
}

test('Échap is answered at the key itself: the question every time, never a close request left to the browser', () => {
  const ui = settings();
  ui.change('changed');
  // A page may refuse a close request only once per user activation, and Échap is not one: the
  // second in a row closed the settings with what was unsaved. Prevented at the key, none is made.
  assert.equal(ui.press(ui.dialog), true);
  assert.equal(ui.confirmation.open, true);
  assert.equal(ui.dialog.open, true);
  // On the question: Échap keeps the settings, as « Continuer ».
  assert.equal(ui.press(ui.confirmation), true);
  assert.equal(ui.confirmation.open, false);
  assert.equal(ui.dialog.open, true);
  // A third time in a row: asked again, still nothing lost.
  assert.equal(ui.press(ui.dialog), true);
  assert.equal(ui.confirmation.open, true);
  assert.equal(ui.guard.isDirty(), true);
  ui.keep.onclick();
  // With the focus lost (its control hidden meanwhile) the key goes to the page: answered too.
  assert.equal(ui.press(null), true);
  assert.equal(ui.confirmation.open, true);
  ui.keep.onclick();
  // Nothing unsaved: Échap closes them, by the page (prevented all the same).
  ui.change('saved');
  assert.equal(ui.press(ui.dialog), true);
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.confirmation.open, false);
});

test('Échap answered inside the settings, or meant for another window, is not the guard’s', () => {
  const ui = settings();
  ui.change('changed');
  // A list of glass, the search: they answered it (and stop it; were it to arrive, it is left).
  assert.equal(ui.press(ui.dialog, { defaultPrevented: true, preventDefault() {} }), true);
  assert.equal(ui.confirmation.open, false);
  // A word being composed: Échap ends it.
  assert.equal(ui.press(ui.dialog, { isComposing: true }), false);
  // Another key.
  assert.equal(ui.press(ui.dialog, { key: 'Enter' }), false);
  // Another window open over the settings (the history to delete): its own key, with the focus in
  // it or lost.
  const other = element();
  other.open = true;
  ui.others.push(other);
  assert.equal(ui.press(other), false);
  assert.equal(ui.press(null), false);
  assert.equal(ui.confirmation.open, false);
  assert.equal(ui.dialog.open, true);
  // The settings closed: nothing to guard.
  other.open = false;
  ui.change('saved');
  ui.guard.requestClose();
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.press(null), false);
});

test('the close request stays guarded as a second line, and a page without a window hears Échap on the settings', () => {
  const ui = settings({ withPage: false });
  ui.change('changed');
  assert.equal(ui.press(ui.dialog), true);
  assert.equal(ui.confirmation.open, true);
  ui.keep.onclick();
  let prevented = false;
  ui.dialog.emit('cancel', { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(ui.confirmation.open, true);
  assert.equal(ui.dialog.open, true);
});
