export function setupSettingsGuard({ dialog, confirmation, readDraft, save, keep, discard, saveButton }) {
  let baseline = null,
    afterClose;
  const snapshot = () => JSON.stringify(readDraft());
  const isDirty = () => dialog.open && baseline !== null && snapshot() !== baseline;
  const markSaved = () => {
    baseline = snapshot();
  };
  const markPartSaved = key => {
    if (baseline !== null) {
      const saved = JSON.parse(baseline);
      saved[key] = readDraft()[key];
      baseline = JSON.stringify(saved);
    }
  };
  function requestClose(after) {
    if (!dialog.open) {
      after?.();
      return;
    }
    if (!isDirty()) {
      dialog.close();
      after?.();
      return;
    }
    afterClose = after;
    if (!confirmation.open) confirmation.showModal();
  }
  function stay() {
    afterClose = undefined;
    confirmation.close();
  }
  keep.onclick = stay;
  discard.onclick = () => {
    const after = afterClose;
    stay();
    dialog.close();
    after?.();
  };
  saveButton.onclick = async () => {
    const after = afterClose;
    stay();
    if (await save()) after?.();
  };
  confirmation.addEventListener('cancel', event => {
    event.preventDefault();
    stay();
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    requestClose();
  });
  // Échap is answered at the key itself (16/11): a page may refuse a close request (`cancel`,
  // above) only once per user activation, and Échap is not one. Pressed again, the browser closed
  // the settings whatever was unsaved. A key prevented is never a close request; `cancel` stays as
  // a second line. Heard on the window, after the page: what answers Échap itself in the settings
  // (a list of glass, the search, the editor of a workflow) stops it on its way; and with the focus
  // lost (its control hidden meanwhile) the key goes to the page, not to the settings.
  const page = dialog.ownerDocument;
  (page?.defaultView ?? dialog).addEventListener?.('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !dialog.open) return;
    // The question lies over the settings: Échap keeps them, as its `cancel` does.
    const top = confirmation.open ? confirmation : dialog,
      within = event.target?.closest?.('dialog[open]');
    // Another window open over them (the history to delete, an update): the key is its own.
    const others = () =>
      [...(page?.querySelectorAll?.('dialog[open]') ?? [])].some(other => other !== dialog && other !== confirmation);
    if (within ? within !== top : others()) return;
    event.preventDefault();
    if (top === confirmation) stay();
    else requestClose();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    baseline = null;
    if (confirmation.open) stay();
  });
  return { isDirty, markSaved, markPartSaved, requestClose };
}
