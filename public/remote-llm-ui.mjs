/**
 * The remote chat models in Paramètres › Moodix AI (parametres-maquette.md, « Vos LLM »). The
 * settings choose the provider and associate its account, nothing more (the model and the effort
 * are chosen in the bar of the chat, model-choice.mjs):
 * - ChatGPT: « Continuer avec ChatGPT », the plan of the user, without a key;
 * - Claude: the key of the Claude Console (Anthropic lets no application sign in with a Claude.ai
 *   account), Anthropic's library installed the first time;
 * - OpenRouter: « Se connecter », a key of the user's account made without copying it.
 * Under « Autre service (adresse) », discreet, any server « compatible OpenAI » (OpenAI by key,
 * Mistral, Groq, Ollama, LM Studio…): its address, its key, its model, whether it sees images.
 * Choosing a line chooses it for the chat; what leaves the computer is said under the list.
 */
const POLL_MS = 1500;
/** Said before the page of OpenRouter opens: what the key is, where it stays, what it may spend. */
export const OPENROUTER_NOTICE =
  'Moodix va ouvrir OpenRouter dans votre navigateur. Si vous acceptez, OpenRouter crée une clé d’API de votre compte pour Moodix : ' +
  'cette clé sera gardée sur cet ordinateur (dans le dossier de données de Moodix). Elle dépense vos crédits OpenRouter si vous choisissez un modèle payant ; ' +
  'les modèles gratuits n’en demandent pas. Vous pourrez la supprimer à tout moment dans votre compte OpenRouter (Keys). Continuer ?';
/** The providers of the list, in their order. */
export const PROVIDER_LINES = Object.freeze([
  { id: 'chatgpt', name: 'ChatGPT', tag: 'Abonnement' },
  { id: 'claude', name: 'Claude', tag: 'Clé' },
  { id: 'openrouter', name: 'OpenRouter', tag: 'Compte' },
]);
const near = host => /^(localhost|127\.|\[::1\]|::1)/i.test(host);
const host = url => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export function setupRemoteModels({
  $,
  api,
  node,
  icon,
  confirmFn = text => confirm(text),
  onStatus = () => {},
  onChange = () => {},
}) {
  let view = { connections: [], active: null, presets: {}, chatgpt: {}, openrouter: {}, claude: {} },
    editing = null,
    baseline = '',
    off = false,
    polling = null,
    // The provider the user chose before its account was associated: chosen once it is.
    waiting = null,
    // The field of the key of Claude, open under its line; made once, so that a list drawn again
    // (a sign-in followed, another line chosen) keeps what is being typed in it, and its focus.
    keyOpen = false,
    keyInput = null,
    focusKey = false;
  const links = { chatgpt: '', openrouter: '' },
    errors = {};
  const fields = {
    preset: $('api-preset'),
    url: $('api-url'),
    key: $('api-key'),
    model: $('api-model'),
    vision: $('api-vision'),
  };
  const say = (text, error = false) => {
    $('api-status').textContent = text;
    $('api-status').classList.toggle('is-error', error);
  };
  const presetOf = id => view.presets[id] ?? { name: 'Autre', baseUrl: '', key: false };
  const ofProvider = id => view.connections.find(item => item.preset === id);
  /** Whether the account of a provider is associated with this computer. */
  function associated(id) {
    if (id === 'chatgpt') return Boolean(view.chatgpt?.connected);
    return Boolean(ofProvider(id)?.hasKey);
  }
  const others = () => view.connections.filter(item => !PROVIDER_LINES.some(line => line.id === item.preset));

  /** What the editor of « Autre service » holds, as the server takes it. */
  function draft() {
    if (!editing) return null;
    const preset = fields.preset.value;
    return {
      ...(editing.id ? { id: editing.id } : {}),
      preset,
      // Its name: the one of its service, or its address for another.
      name: preset === 'custom' ? host(fields.url.value) || presetOf(preset).name : presetOf(preset).name,
      baseUrl: fields.url.value,
      model: fields.model.value,
      vision: fields.vision.checked,
      ...(fields.key.value ? { key: fields.key.value } : {}),
    };
  }
  /** A key of Claude typed and not kept yet. */
  const typedKey = () => (keyOpen && keyInput?.value.trim()) || '';
  /** Something written here and not saved: the editor of « Autre service » changed, or a key of Claude typed. */
  const dirty = () => (Boolean(editing) && JSON.stringify(draft()) !== baseline) || Boolean(typedKey());
  /**
   * What the field of the key says: the kept one, only for the address it was given for. Another
   * address, and it is not sent there: a key of that server is asked for.
   */
  function keyHint() {
    const item = editing?.id ? view.connections.find(connection => connection.id === editing.id) : null,
      same = Boolean(item?.hasKey) && host(item.baseUrl) === host(fields.url.value);
    fields.key.placeholder = same
      ? 'Clé enregistrée · collez-en une autre pour la remplacer'
      : item?.hasKey
        ? 'Nouvelle adresse : collez sa clé (la clé enregistrée ne lui sera pas envoyée)'
        : presetOf(fields.preset.value).key
          ? 'Collez votre clé'
          : 'Aucune clé (serveur local)';
    $('api-remove-key').hidden = !same;
  }
  function privacy() {
    keyHint();
    const where = host(fields.url.value);
    $('api-privacy').textContent = !where
      ? ''
      : near(where)
        ? 'Ce serveur tourne sur cet ordinateur : rien ne quitte l’ordinateur.'
        : `En l’enregistrant, vous le choisissez pour le chat : vos messages, les images jointes et les références montrées au modèle partiront chez ${where}. La clé reste sur cet ordinateur.`;
  }
  function fillModels(items) {
    $('api-models').replaceChildren(
      ...items.map(item => {
        const option = node('option');
        option.value = item.id;
        return option;
      }),
    );
  }
  /** The editor of « Autre service » opened on `item`, or on a new one. */
  function open(item) {
    const preset = item?.preset ?? 'ollama',
      service = presetOf(preset);
    editing = { id: item?.id };
    fields.preset.value = preset;
    // The service the next change starts from (the button of glass over the list gives it no focus).
    former = preset;
    fields.url.value = item?.baseUrl ?? service.baseUrl;
    fields.key.value = '';
    fields.model.value = item?.model ?? '';
    fields.vision.checked = item?.vision ?? false;
    $('api-editor').open = true;
    fillModels([]);
    say('');
    privacy();
    baseline = JSON.stringify(draft());
    onChange();
  }
  function close() {
    editing = null;
    baseline = '';
    $('api-editor').open = false;
    say('');
    onChange();
  }
  function cancel() {
    if (dirty() && !confirmFn('Abandonner les modifications de ce service ?')) return false;
    close();
    return true;
  }
  /** One action at a time; what stops it is said where it was asked (`where`: a provider, else the editor). */
  async function act(task, { working = '', where = null } = {}) {
    if (off) return false;
    setBusy(true);
    if (where) delete errors[where];
    else if (working) say(working);
    try {
      return await task();
    } catch (error) {
      if (where) errors[where] = error.message;
      else say(error.message, true);
      return false;
    } finally {
      setBusy(false);
      onChange();
    }
  }
  const take = (result, status = true) => {
    view = result;
    if (status && result.status) onStatus(result.status);
  };

  // « Autre service »: listing, testing, saving (which chooses it).
  const listModels = () =>
    act(
      async () => {
        const { models } = await (await api('remote/models', draft())).json();
        fillModels(models);
        say(
          models.length
            ? `${models.length} modèle${models.length > 1 ? 's' : ''} proposé${models.length > 1 ? 's' : ''} dans le champ Modèle.`
            : 'Ce service ne liste pas ses modèles : écrivez le nom exact.',
        );
        return true;
      },
      { working: 'Lecture des modèles…' },
    );
  const test = () =>
    act(
      async () => {
        const { said } = await (await api('remote/test', draft())).json();
        say(`Connexion réussie${said ? ` : le modèle répond « ${said} »` : ''}.`);
        return true;
      },
      { working: 'Essai de la connexion…' },
    );
  /**
   * What is written here, saved (« Enregistrer » of the settings, or the one of the editor): a key
   * of Claude typed (checked, kept, Claude chosen), then the editor of « Autre service » (saved and
   * chosen). False when one of them fails: the settings stay open with what stopped it.
   */
  async function save() {
    const key = typedKey();
    if (key && !(await useProvider('claude', { key }))) return false;
    if (!editing) return true;
    return act(
      async () => {
        const saved = await (await api('remote/save', draft())).json();
        take(await (await api('remote/select', { id: saved.saved.id })).json());
        close();
        return true;
      },
      { working: 'Enregistrement…' },
    );
  }
  async function removeKey() {
    if (!editing?.id) return;
    await act(async () => {
      take(await (await api('remote/save', { ...draft(), key: '' })).json(), false);
      fields.key.placeholder = 'Aucune clé';
      $('api-remove-key').hidden = true;
      baseline = JSON.stringify(draft());
      say('Clé retirée de cet ordinateur.');
      return true;
    });
  }
  /** A line of « Autre service » chosen for the chat, or none (null: the local model). */
  const select = id => act(async () => (take(await (await api('remote/select', { id })).json()), true));
  async function remove(id) {
    const item = view.connections.find(connection => connection.id === id);
    if (!item || !confirmFn(`Retirer « ${item.name} » de la liste ? Sa clé est effacée de cet ordinateur.`)) return;
    await act(async () => {
      take(await (await api('remote/remove', { id })).json());
      if (editing?.id === id) close();
      return true;
    });
  }

  // The providers: their account associated, then chosen.
  const useProvider = (id, extra = {}) =>
    act(
      async () => {
        take(await (await api('remote/provider', { provider: id, ...extra })).json());
        waiting = null;
        if (id === 'claude') {
          keyOpen = false;
          if (keyInput) keyInput.value = '';
        }
        return true;
      },
      { where: id },
    );
  async function signInChatGPT() {
    await act(
      async () => {
        const { url } = await (await api('remote/chatgpt/start', {})).json();
        links.chatgpt = url;
        view.chatgpt = { ...view.chatgpt, pending: true, error: '' };
        waiting = 'chatgpt';
        return true;
      },
      { where: 'chatgpt' },
    );
    void poll();
  }
  async function signInOpenRouter() {
    if (off || !confirmFn(OPENROUTER_NOTICE)) return;
    await act(
      async () => {
        const { url } = await (await api('remote/openrouter/start', {})).json();
        links.openrouter = url;
        view.openrouter = { pending: true, error: '', created: null };
        waiting = 'openrouter';
        return true;
      },
      { where: 'openrouter' },
    );
    void poll();
  }
  const cancelSignIn = id =>
    act(
      async () => {
        take(await (await api(`remote/${id}/cancel`, {})).json(), false);
        if (waiting === id) waiting = null;
        return true;
      },
      { where: id },
    );
  async function forget(id) {
    const question = {
      chatgpt:
        'Se déconnecter de ChatGPT ? Moodix ne pourra plus utiliser votre abonnement jusqu’à la prochaine connexion.',
      claude:
        'Retirer la clé de Claude de cet ordinateur ? Elle reste valable dans votre Claude Console tant que vous ne l’y supprimez pas.',
      openrouter:
        'Se déconnecter d’OpenRouter ? La clé est effacée de cet ordinateur ; elle reste valable dans votre compte OpenRouter tant que vous ne l’y supprimez pas (Keys).',
    }[id];
    if (!confirmFn(question)) return;
    await act(
      async () => {
        const result = await (await api('remote/forget', { provider: id })).json();
        take(result);
        if (id === 'chatgpt' && result.revoked === false)
          errors.chatgpt =
            'Déconnecté ici ; OpenAI n’a pas confirmé la fin de la session (vous pouvez retirer Moodix dans les réglages de ChatGPT).';
        return true;
      },
      { where: id },
    );
  }
  const installClaude = () =>
    act(
      async () => {
        take(await (await api('remote/claude/install', {})).json(), false);
        waiting = 'claude';
        void poll();
        return true;
      },
      { where: 'claude' },
    );
  /** A line of a provider chosen: chosen at once when its account is associated, else its association begins. */
  function choose(id) {
    if (associated(id)) return void useProvider(id);
    if (id === 'chatgpt') return void signInChatGPT();
    if (id === 'openrouter') return void signInOpenRouter();
    if (view.claude?.library === 'ready') {
      keyOpen = focusKey = true;
      onChange();
      return;
    }
    if (view.claude?.library !== 'installing') void installClaude();
  }
  async function poll() {
    clearTimeout(polling);
    polling = null;
    try {
      const before = JSON.stringify(view);
      view = await (await api('remote')).json();
      // Associated meanwhile: the provider the user chose is chosen now.
      if (waiting === 'chatgpt' && !view.chatgpt?.pending) {
        if (view.chatgpt?.connected) await useProvider('chatgpt');
        else waiting = null;
      } else if (waiting === 'openrouter' && !view.openrouter?.pending) {
        if (associated('openrouter')) await useProvider('openrouter');
        else waiting = null;
      } else if (waiting === 'claude' && view.claude?.library !== 'installing') {
        waiting = null;
        if (view.claude?.library === 'ready') keyOpen = focusKey = true;
      }
      // Drawn again only when something changed: a list drawn while the user acts on it loses the
      // focus of the button in hand.
      if (JSON.stringify(view) !== before) onChange();
    } catch {
      // Asked again below.
    }
    if (view.chatgpt?.pending || view.openrouter?.pending || view.claude?.library === 'installing')
      polling = setTimeout(poll, POLL_MS);
  }

  /** What the line of a provider says under its name. */
  function said(id) {
    const chosen = ofProvider(id);
    if (id === 'chatgpt') {
      const account = view.chatgpt ?? {};
      if (account.pending) return 'Terminez la connexion dans la page de ChatGPT ouverte dans votre navigateur.';
      if (account.connected)
        return (
          `Connecté${account.email ? ` · ${account.email}` : ''}` +
          (account.plan ? '' : ' · usage de l’abonnement non autorisé')
        );
      return 'Votre abonnement Plus ou Pro, sans clé d’API';
    }
    if (id === 'claude') {
      const library = view.claude?.library;
      if (library === 'installing') return 'Installation de la bibliothèque officielle d’Anthropic…';
      if (library === 'missing' || library === 'outdated')
        return 'La bibliothèque officielle d’Anthropic s’installe au premier choix (environ 17 Mo)';
      if (chosen?.hasKey) return 'Clé de la Claude Console enregistrée sur cet ordinateur';
      return 'Votre clé d’API de la Claude Console (pas de connexion par abonnement Claude)';
    }
    if (view.openrouter?.pending)
      return 'Terminez la connexion dans la page d’OpenRouter ouverte dans votre navigateur.';
    if (chosen?.hasKey) return 'Connecté · clé de votre compte gardée sur cet ordinateur';
    return 'Votre compte OpenRouter, sans copier de clé : modèles gratuits ou avec vos crédits';
  }
  function button(text, onclick, className = 'text-button') {
    const element = node('button', className, text);
    element.type = 'button';
    element.disabled = off;
    element.onclick = onclick;
    return element;
  }
  /** What can be done on the line of a provider: associate, sign out, cancel a sign-in. */
  function actions(id) {
    const box = node('div', 'provider-actions');
    if (id === 'chatgpt') {
      const account = view.chatgpt ?? {};
      if (account.pending) {
        if (links.chatgpt) {
          const link = node('a', 'text-button', 'Ouvrir la page');
          link.href = links.chatgpt;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          box.append(link);
        }
        box.append(button('Annuler', () => void cancelSignIn('chatgpt')));
      } else if (account.connected) box.append(button('Se déconnecter', () => void forget('chatgpt')));
      else box.append(button('Continuer avec ChatGPT', () => void signInChatGPT(), 'secondary'));
    } else if (id === 'claude') {
      const library = view.claude?.library;
      if (library === 'installing') box.append(node('span', 'provider-working', 'Installation…'));
      else if (library !== 'ready') box.append(button('Installer', () => void installClaude(), 'secondary'));
      else if (ofProvider('claude')?.hasKey) {
        box.append(button('Changer la clé', () => ((keyOpen = focusKey = true), onChange())));
        box.append(button('Retirer', () => void forget('claude')));
      } else if (!keyOpen) box.append(button('Associer une clé', () => ((keyOpen = focusKey = true), onChange()), 'secondary'));
    } else if (view.openrouter?.pending) {
      if (links.openrouter) {
        const link = node('a', 'text-button', 'Ouvrir la page');
        link.href = links.openrouter;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        box.append(link);
      }
      box.append(button('Annuler', () => void cancelSignIn('openrouter')));
    } else if (ofProvider('openrouter')?.hasKey) box.append(button('Se déconnecter', () => void forget('openrouter')));
    else box.append(button('Se connecter', () => void signInOpenRouter(), 'secondary'));
    return box;
  }
  /** The field of the key of Claude, under its line. */
  function keyField() {
    // The field itself is kept from one drawing to the next: what is typed, and its focus, stay.
    if (!keyInput) {
      keyInput = node('input');
      keyInput.type = 'password';
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      keyInput.placeholder = 'sk-ant-…  (console.anthropic.com › API Keys)';
      keyInput.setAttribute('aria-label', 'Clé d’API de la Claude Console');
      keyInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (keyInput.value.trim()) void useProvider('claude', { key: keyInput.value.trim() });
        }
      });
    }
    const box = node('div', 'provider-key'),
      keep = button(
        'Enregistrer',
        () => keyInput.value.trim() && void useProvider('claude', { key: keyInput.value.trim() }),
        'primary',
      ),
      leave = button('Annuler', () => {
        keyOpen = false;
        keyInput.value = '';
        delete errors.claude;
        onChange();
      });
    keyInput.disabled = off;
    box.append(keyInput, keep, leave);
    // Its focus given once, when it opens (not at every drawing).
    if (focusKey) {
      focusKey = false;
      queueMicrotask(() => keyInput.focus?.());
    }
    return box;
  }
  /** The line of a provider: chosen or not, what it says, what can be done there. */
  function providerRow(line, busy) {
    const chosen = ofProvider(line.id),
      lit = Boolean(chosen) && chosen.id === view.active,
      row = node('div', 'llm-row is-provider' + (lit ? ' is-chosen' : '')),
      pick = node('button', 'llm-pick'),
      head = node('span', 'llm-head');
    pick.type = 'button';
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-checked', String(lit));
    head.append(node('span', 'llm-name', line.name), node('span', 'llm-tag is-api', line.tag));
    pick.append(node('span', 'llm-radio'), head, node('span', 'llm-path', said(line.id)));
    pick.disabled = busy || off;
    pick.onclick = () => choose(line.id);
    row.append(pick, actions(line.id));
    if (line.id === 'claude' && keyOpen && view.claude?.library === 'ready') row.append(keyField());
    if (
      errors[line.id] ||
      (line.id === 'chatgpt' && view.chatgpt?.error) ||
      (line.id === 'openrouter' && view.openrouter?.error)
    )
      row.append(node('p', 'config-error provider-error', errors[line.id] || view[line.id]?.error));
    return row;
  }
  /** A line of « Autre service »: its address and its model in mono. */
  function otherRow(item, busy) {
    const lit = item.id === view.active,
      row = node('div', 'llm-row is-api' + (lit ? ' is-chosen' : '')),
      pick = node('button', 'llm-pick'),
      head = node('span', 'llm-head'),
      edit = node('button', 'llm-edit'),
      removing = node('button', 'llm-remove');
    pick.type = edit.type = removing.type = 'button';
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-checked', String(lit));
    head.append(node('span', 'llm-name', item.name), node('span', 'llm-tag is-api', 'API'));
    if (item.vision) head.append(node('span', 'llm-tag', 'Vision'));
    pick.append(node('span', 'llm-radio'), head, node('span', 'llm-path', `${host(item.baseUrl)} · ${item.model}`));
    pick.disabled = edit.disabled = removing.disabled = busy || off;
    pick.onclick = () => void select(item.id);
    edit.append(icon('edit'));
    edit.title = 'Modifier';
    edit.setAttribute('aria-label', 'Modifier ' + item.name);
    edit.onclick = () => {
      if (dirty() && !confirmFn('Abandonner les modifications de ce service ?')) return;
      open(item);
    };
    removing.append(icon('trash'));
    removing.title = 'Retirer de la liste';
    removing.setAttribute('aria-label', 'Retirer ' + item.name + ' de la liste');
    removing.onclick = () => void remove(item.id);
    row.append(pick, edit, removing);
    return row;
  }
  /** The lines of « Vos LLM » after the local ones; `busy`: the list is locked. */
  function rows(busy) {
    const rest = others();
    return [
      ...PROVIDER_LINES.map(line => providerRow(line, busy)),
      ...(rest.length ? [node('p', 'llm-group', 'Autres services'), ...rest.map(item => otherRow(item, busy))] : []),
    ];
  }

  function setBusy(value) {
    off = value;
    for (const control of [
      ...Object.values(fields),
      $('api-test'),
      $('api-save'),
      $('api-cancel'),
      $('api-list'),
      $('api-remove-key'),
    ])
      control.disabled = value;
  }
  /** The services of « Autre service », as the server knows them (the three providers apart). */
  function renderPresets() {
    fields.preset.replaceChildren(
      ...Object.entries(view.presets)
        .filter(([id]) => !PROVIDER_LINES.some(line => line.id === id))
        .map(([id, service]) => {
          const option = node('option', '', service.name);
          option.value = id;
          return option;
        }),
    );
  }
  async function load() {
    view = await (await api('remote')).json();
    renderPresets();
    if ((view.chatgpt?.pending || view.openrouter?.pending || view.claude?.library === 'installing') && !polling)
      void poll();
    onChange();
    return view;
  }

  // A service chosen: its address, unless the user wrote their own.
  let former = fields.preset.value;
  fields.preset.addEventListener('change', () => {
    const before = presetOf(former),
      next = presetOf(fields.preset.value);
    if (!fields.url.value || fields.url.value === before.baseUrl) fields.url.value = next.baseUrl;
    former = fields.preset.value;
    fillModels([]);
    privacy();
  });
  fields.preset.addEventListener('focus', () => (former = fields.preset.value));
  fields.url.addEventListener('input', privacy);
  $('add-api').onclick = () => {
    if (dirty() && !confirmFn('Abandonner les modifications de ce service ?')) return;
    open(null);
    former = fields.preset.value;
    fields.url.focus?.();
  };
  $('api-cancel').onclick = () => cancel();
  $('api-save').onclick = () => void save();
  $('api-test').onclick = () => void test();
  $('api-list').onclick = () => void listModels();
  $('api-remove-key').onclick = () => void removeKey();

  return {
    load,
    rows,
    draft,
    dirty,
    save,
    select,
    cancel,
    close,
    /** Locked while the page works elsewhere (a save, a generation). */
    lock(value) {
      $('add-api').disabled = value;
    },
    active: () => view.active,
    connections: () => view.connections,
  };
}
