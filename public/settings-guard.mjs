export function setupSettingsGuard({ dialog, confirmation, readDraft, save, keep, discard, saveButton }) {
  let baseline = null, afterClose;
  const snapshot = () => JSON.stringify(readDraft());
  const isDirty = () => dialog.open && baseline !== null && snapshot() !== baseline;
  const markSaved = () => { baseline = snapshot(); };
  function requestClose(after) {
    if (!dialog.open) { after?.(); return; }
    if (!isDirty()) { dialog.close(); after?.(); return; }
    afterClose = after;
    if (!confirmation.open) confirmation.showModal();
  }
  function stay() { afterClose = undefined; confirmation.close(); }
  keep.onclick = stay;
  discard.onclick = () => { const after = afterClose; stay(); dialog.close(); after?.(); };
  saveButton.onclick = async () => {
    const after = afterClose; stay();
    if (await save()) after?.();
  };
  confirmation.addEventListener('cancel', event => { event.preventDefault(); stay(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    baseline = null;
    if (confirmation.open) stay();
  });
  return { isDirty, markSaved, requestClose };
}
