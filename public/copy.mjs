export function setupCopy(root, { writeText = text => navigator.clipboard.writeText(text), announce = () => {} } = {}) {
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-code],[data-copy-response]');
    if (!button || !root.contains(button) || button.disabled) return;
    const text = button.hasAttribute('data-copy-code')
      ? button.closest('pre').querySelector('code').textContent
      : button.closest('.message').querySelector('.message-body').dataset.copyText;
    if (!text) return;
    const label = button.querySelector('span'), original = label.textContent;
    button.disabled = true;
    try {
      await writeText(text);
      label.textContent = 'Copié'; announce('Texte copié.');
      setTimeout(() => { label.textContent = original; button.disabled = false; }, 1600);
    } catch {
      button.disabled = false;
      announce('Copie indisponible. Sélectionnez le texte pour le copier manuellement.');
    }
  });
}
