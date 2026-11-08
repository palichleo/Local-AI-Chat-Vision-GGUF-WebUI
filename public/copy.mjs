export function quoteText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.matches?.('.copy-button,.code-label')) return '';
  if (node.tagName === 'BR') return '\n';
  const text = Array.from(node.childNodes || [], quoteText).join('');
  if (/^(P|H[1-6])$/.test(node.tagName)) return text + '\n\n';
  if (/^(LI|PRE|BLOCKQUOTE)$/.test(node.tagName)) return text + '\n';
  return text;
}

export function setupCopy(root, { writeText = text => navigator.clipboard.writeText(text), announce = () => {} } = {}) {
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-code],[data-copy-quote]');
    if (!button || !root.contains(button) || button.disabled) return;
    const text = button.hasAttribute('data-copy-code')
      ? button.closest('.code-block').querySelector('code').textContent
      : quoteText(button.closest('blockquote').querySelector('.copy-content')).trim();
    if (!text) return;
    const label = button.querySelector('span'), original = label.textContent, title = button.title;
    button.disabled = true;
    try {
      await writeText(text);
      label.textContent = 'Copié'; button.title = 'Copié'; announce('Texte copié.');
      setTimeout(() => { label.textContent = original; button.title = title; button.disabled = false; }, 1600);
    } catch {
      button.disabled = false;
      announce('Copie indisponible. Sélectionnez le texte pour le copier manuellement.');
    }
  });
}
