/**
 * The remote chat models in Paramètres › Moodix AI (parametres-maquette.md, « Vos LLM »): each API
 * is a line of the list beside the local LLMs, tagged API, its address and its model in mono, its
 * key never shown. « Ajouter une API » opens its editor under the list (a service, an address, a
 * key, a model, whether it sees images, « Tester la connexion »); « Continuer avec ChatGPT » signs
 * in to the account of the user, without a key; « Se connecter à OpenRouter » makes a key of the
 * user's OpenRouter account without copying it, then opens the editor of that connection to choose
 * its model. What leaves the computer is said where the connection is saved, and saving it
 * chooses it for the chat.
 */
const POLL_MS = 1500;
/** Said before the page of OpenRouter opens: what the key is, where it stays, what it may spend. */
export const OPENROUTER_NOTICE =
  'Moodix va ouvrir OpenRouter dans votre navigateur. Si vous acceptez, OpenRouter crée une clé d’API de votre compte pour Moodix : ' +
  'cette clé sera gardée sur cet ordinateur (dans le dossier de données de Moodix). Elle dépense vos crédits OpenRouter si vous choisissez un modèle payant ; ' +
  'les modèles gratuits n’en demandent pas. Vous pourrez la supprimer à tout moment dans votre compte OpenRouter (Keys). Continuer ?';
const FREE_HINT =
  ' Ceux qui finissent par :free sont gratuits (50 demandes par jour tant qu’aucun crédit n’est acheté) ; openrouter/free en choisit un pour vous.';
const near = host => /^(localhost|127\.|\[::1\]|::1)/i.test(host);

export function setupRemoteModels({
  $,
  api,
  node,
  icon,
  confirmFn = text => confirm(text),
  onStatus = () => {},
  onChange = () => {},
}) {
  let view = { connections: [], active: null, presets: {}, chatgpt: {}, openrouter: {} },
    editing = null,
    baseline = '',
    off = false,
    polling = null,
    listed = [];
  const fields = {
    preset: $('api-preset'),
    name: $('api-name'),
    url: $('api-url'),
    key: $('api-key'),
    model: $('api-model'),
    vision: $('api-vision'),
  };
  const say = (text, error = false) => {
    $('api-status').textContent = text;
    $('api-status').classList.toggle('is-error', error);
  };

  function presetOf(id) {
    return view.presets[id] ?? { name: 'Autre', baseUrl: '', key: false };
  }
  /** What the editor holds, as the server takes it. */
  function draft() {
    if (!editing) return null;
    return {
      ...(editing.id ? { id: editing.id } : {}),
      preset: editing.preset === 'chatgpt' ? 'chatgpt' : fields.preset.value,
      name: fields.name.value,
      baseUrl: fields.url.value,
      model: fields.model.value,
      vision: fields.vision.checked,
      ...(fields.key.value ? { key: fields.key.value } : {}),
    };
  }
  const dirty = () => Boolean(editing) && JSON.stringify(draft()) !== baseline;
  function host(url) {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }
  /** What leaves the computer with this connection, said beside Enregistrer. */
  function privacy() {
    const chatgpt = editing?.preset === 'chatgpt',
      where = chatgpt ? 'OpenAI (ChatGPT)' : host(fields.url.value);
    $('api-privacy').textContent = !where
      ? ''
      : !chatgpt && near(where)
        ? 'Ce serveur tourne sur cet ordinateur : rien ne quitte l’ordinateur.'
        : `En l’enregistrant, vous le choisissez pour le chat : vos messages, les images jointes et les références montrées au modèle partiront chez ${where}.` +
          (chatgpt ? ' Votre abonnement compte ce que vous lui demandez.' : ' La clé reste sur cet ordinateur.');
  }
  function fillModels(items) {
    listed = items;
    $('api-models').replaceChildren(
      ...items.map(item => {
        const option = node('option');
        option.value = item.id;
        if (item.name && item.name !== item.id) option.label = item.name;
        return option;
      }),
    );
  }
  /** The editor opened on `item` (a connection), or on a new one of `preset`. */
  function open(item, preset = 'openrouter') {
    const chosen = item?.preset ?? preset,
      service = presetOf(chosen);
    editing = { id: item?.id, preset: chosen };
    fields.preset.value = chosen === 'chatgpt' ? 'custom' : chosen;
    fields.name.value = item?.name ?? service.name;
    fields.url.value = item?.baseUrl ?? service.baseUrl;
    fields.key.value = '';
    fields.key.placeholder = item?.hasKey
      ? 'Clé enregistrée · collez-en une autre pour la remplacer'
      : service.key
        ? 'Collez votre clé'
        : 'Aucune clé (serveur local)';
    fields.model.value = item?.model ?? '';
    fields.vision.checked = item?.vision ?? chosen === 'chatgpt';
    $('api-remove-key').hidden = !item?.hasKey;
    // ChatGPT has no address nor key: its account answers.
    for (const id of ['api-preset-field', 'api-url-field', 'api-key-field']) $(id).hidden = chosen === 'chatgpt';
    $('api-list').hidden = false;
    $('api-editor').open = true;
    fillModels([]);
    say('');
    privacy();
    baseline = JSON.stringify(draft());
    if (chosen === 'chatgpt') void listModels();
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
    if (dirty() && !confirmFn('Abandonner les modifications de cette API ?')) return false;
    close();
    return true;
  }
  async function act(task, working) {
    if (off) return false;
    setBusy(true);
    if (working) say(working);
    try {
      return await task();
    } catch (error) {
      say(error.message, true);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function listModels() {
    return act(async () => {
      const { models } = await (await api('remote/models', draft())).json();
      fillModels(models);
      if (editing?.preset === 'chatgpt' && !fields.model.value && models[0]) fields.model.value = models[0].id;
      say(
        models.length
          ? `${models.length} modèle${models.length > 1 ? 's' : ''} proposé${models.length > 1 ? 's' : ''} dans le champ Modèle.` +
              (fields.preset.value === 'openrouter' && editing?.preset !== 'chatgpt' ? FREE_HINT : '')
          : 'Ce service ne liste pas ses modèles : écrivez le nom exact.',
      );
      return true;
    }, 'Lecture des modèles…');
  }
  async function test() {
    return act(async () => {
      const { said } = await (await api('remote/test', draft())).json();
      say(`Connexion réussie${said ? ` : le modèle répond « ${said} »` : ''}.`);
      return true;
    }, 'Essai de la connexion…');
  }
  /** Saves the connection of the editor and chooses it for the chat (true once done). */
  async function save() {
    if (!editing) return true;
    return act(async () => {
      const saved = await (await api('remote/save', draft())).json();
      const chosen = await (await api('remote/select', { id: saved.saved.id })).json();
      view = chosen;
      onStatus(chosen.status);
      close();
      return true;
    }, 'Enregistrement…');
  }
  async function removeKey() {
    if (!editing?.id) return;
    await act(async () => {
      view = await (await api('remote/save', { ...draft(), key: '' })).json();
      fields.key.placeholder = 'Aucune clé';
      $('api-remove-key').hidden = true;
      baseline = JSON.stringify(draft());
      say('Clé retirée de cet ordinateur.');
      onChange();
      return true;
    });
  }
  async function select(id) {
    return act(async () => {
      view = await (await api('remote/select', { id })).json();
      onStatus(view.status);
      onChange();
      return true;
    });
  }
  async function remove(id) {
    const item = view.connections.find(connection => connection.id === id);
    const still =
      item?.preset === 'openrouter' && item.hasKey
        ? ' Elle reste valable dans votre compte OpenRouter tant que vous ne l’y supprimez pas (Keys).'
        : '';
    if (!item || !confirmFn(`Retirer « ${item.name} » de la liste ? Sa clé est effacée de cet ordinateur.${still}`))
      return;
    await act(async () => {
      view = await (await api('remote/remove', { id })).json();
      renderOpenRouter();
      if (editing?.id === id) close();
      onStatus(view.status);
      onChange();
      return true;
    });
  }
  /** One line of « Vos LLM » per connection; `busy`: the list is locked. */
  function rows(busy) {
    return view.connections.map(item => {
      const lit = item.id === view.active,
        row = node('div', 'llm-row is-api' + (lit ? ' is-chosen' : '')),
        pick = node('button', 'llm-pick'),
        head = node('span', 'llm-head'),
        edit = node('button', 'llm-edit'),
        removing = node('button', 'llm-remove');
      pick.type = edit.type = removing.type = 'button';
      pick.setAttribute('role', 'radio');
      pick.setAttribute('aria-checked', String(lit));
      head.append(
        node('span', 'llm-name', item.name),
        node('span', 'llm-tag is-api', item.preset === 'chatgpt' ? 'ChatGPT' : 'API'),
      );
      if (item.vision) head.append(node('span', 'llm-tag', 'Vision'));
      pick.append(node('span', 'llm-radio'), head, node('span', 'llm-path', `${host(item.baseUrl)} · ${item.model}`));
      pick.disabled = busy || off;
      pick.onclick = () => void select(item.id);
      edit.append(icon('edit'));
      edit.title = 'Modifier';
      edit.setAttribute('aria-label', 'Modifier ' + item.name);
      edit.disabled = busy || off;
      edit.onclick = () => {
        if (dirty() && !confirmFn('Abandonner les modifications de cette API ?')) return;
        open(item);
        fields.name.focus();
      };
      removing.append(icon('trash'));
      removing.title = 'Retirer de la liste';
      removing.setAttribute('aria-label', 'Retirer ' + item.name + ' de la liste');
      removing.disabled = busy || off;
      removing.onclick = () => void remove(item.id);
      row.append(pick, edit, removing);
      return row;
    });
  }

  /** The line of the ChatGPT account: sign in, the sign-in waiting, signed in (its email). */
  function renderAccount() {
    const account = view.chatgpt ?? {};
    $('chatgpt-signin').hidden = account.connected || account.pending;
    $('chatgpt-cancel').hidden = !account.pending;
    $('chatgpt-signout').hidden = !account.connected;
    $('chatgpt-link').hidden = !account.pending || !$('chatgpt-link').href;
    $('chatgpt-status').textContent = account.pending
      ? 'Terminez la connexion dans la page de ChatGPT ouverte dans votre navigateur.'
      : account.connected
        ? `Connecté à ChatGPT${account.email ? ` (${account.email})` : ''}.` +
          (account.plan ? '' : ' L’usage de l’abonnement n’est pas autorisé.')
        : 'Avec votre abonnement ChatGPT Plus ou Pro, sans clé d’API.';
    $('chatgpt-error').textContent = account.error || '';
    $('chatgpt-error').hidden = !account.error;
    for (const id of ['chatgpt-signin', 'chatgpt-cancel', 'chatgpt-signout']) $(id).disabled = off;
  }
  /** The line of « Se connecter à OpenRouter »: the sign-in waiting, what stopped it, the connection made. */
  function renderOpenRouter() {
    const sign = view.openrouter ?? {},
      made = !sign.pending && view.connections.some(item => item.id === sign.created);
    $('openrouter-signin').hidden = Boolean(sign.pending);
    $('openrouter-cancel').hidden = !sign.pending;
    $('openrouter-link').hidden = !sign.pending || !$('openrouter-link').href;
    $('openrouter-status').textContent = sign.pending
      ? 'Terminez la connexion dans la page d’OpenRouter ouverte dans votre navigateur.'
      : made
        ? 'La clé de votre compte OpenRouter est gardée sur cet ordinateur : la connexion est dans la liste.'
        : 'Avec votre compte OpenRouter, sans copier de clé : ses modèles gratuits, ou les autres avec vos crédits.';
    $('openrouter-error').textContent = sign.error || '';
    $('openrouter-error').hidden = !sign.error;
    for (const id of ['openrouter-signin', 'openrouter-cancel']) $(id).disabled = off;
  }
  function renderAccounts() {
    renderAccount();
    renderOpenRouter();
  }
  async function poll() {
    clearTimeout(polling);
    polling = null;
    try {
      const before = view.chatgpt?.connected,
        waiting = view.openrouter?.pending;
      view = await (await api('remote')).json();
      renderAccounts();
      onChange();
      // Signed in: its model to choose, then Enregistrer.
      if (!before && view.chatgpt?.connected && !view.connections.some(item => item.preset === 'chatgpt'))
        open(null, 'chatgpt');
      // Back from OpenRouter with a key: the editor of the connection it made, its models listed.
      const made =
        waiting &&
        !view.openrouter?.pending &&
        view.connections.find(item => item.id === view.openrouter?.created && item.preset === 'openrouter');
      if (made && !dirty()) {
        open(made);
        void listModels().then(() => fields.model.focus());
      }
    } catch {
      // Asked again below.
    }
    if (view.chatgpt?.pending || view.openrouter?.pending) polling = setTimeout(poll, POLL_MS);
  }
  async function openRouterSignIn() {
    if (off || !confirmFn(OPENROUTER_NOTICE)) return;
    setBusy(true);
    try {
      const { url } = await (await api('remote/openrouter/start', {})).json();
      $('openrouter-link').href = url;
      view.openrouter = { pending: true, error: '', created: null };
    } catch (error) {
      view.openrouter = { ...view.openrouter, pending: false, error: error.message };
    } finally {
      setBusy(false);
    }
    if (view.openrouter.pending) void poll();
  }
  async function cancelOpenRouter() {
    clearTimeout(polling);
    await act(async () => {
      view = await (await api('remote/openrouter/cancel', {})).json();
      renderAccounts();
      onChange();
      // A sign-in of ChatGPT still waiting is followed again.
      if (view.chatgpt?.pending) void poll();
      return true;
    });
  }
  async function signIn() {
    await act(async () => {
      const { url } = await (await api('remote/chatgpt/start', {})).json();
      $('chatgpt-link').href = url;
      view.chatgpt = { ...view.chatgpt, pending: true, error: '' };
      renderAccount();
      void poll();
      return true;
    });
  }
  async function cancelSignIn() {
    clearTimeout(polling);
    await act(async () => {
      view = await (await api('remote/chatgpt/cancel', {})).json();
      renderAccounts();
      // A sign-in of OpenRouter still waiting is followed again.
      if (view.openrouter?.pending) void poll();
      return true;
    });
  }
  async function signOut() {
    if (
      !confirmFn(
        'Se déconnecter de ChatGPT ? Moodix ne pourra plus utiliser votre abonnement jusqu’à la prochaine connexion.',
      )
    )
      return;
    await act(async () => {
      const result = await (await api('remote/chatgpt/signout', {})).json();
      view = result;
      renderAccount();
      $('chatgpt-error').textContent = result.revoked
        ? ''
        : 'Déconnecté ici ; OpenAI n’a pas confirmé la fin de la session (vous pouvez retirer Moodix dans les réglages de ChatGPT).';
      $('chatgpt-error').hidden = result.revoked;
      onChange();
      return true;
    });
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
    renderAccounts();
  }
  /** The services of the list, as the server knows them (ChatGPT apart: it has its own button). */
  function renderPresets() {
    fields.preset.replaceChildren(
      ...Object.entries(view.presets)
        .filter(([id]) => id !== 'chatgpt')
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
    renderAccounts();
    if ((view.chatgpt?.pending || view.openrouter?.pending) && !polling) void poll();
    onChange();
    return view;
  }

  // A service chosen: its address and its name, unless the user wrote their own.
  let former = fields.preset.value;
  fields.preset.addEventListener('change', () => {
    const before = presetOf(former),
      next = presetOf(fields.preset.value);
    if (!fields.url.value || fields.url.value === before.baseUrl) fields.url.value = next.baseUrl;
    if (!fields.name.value || fields.name.value === before.name) fields.name.value = next.name;
    if (!editing?.id) fields.key.placeholder = next.key ? 'Collez votre clé' : 'Aucune clé (serveur local)';
    former = fields.preset.value;
    fillModels([]);
    privacy();
  });
  fields.preset.addEventListener('focus', () => (former = fields.preset.value));
  fields.url.addEventListener('input', privacy);
  $('add-api').onclick = () => {
    if (dirty() && !confirmFn('Abandonner les modifications de cette API ?')) return;
    open(null);
    former = fields.preset.value;
    fields.name.focus();
  };
  $('api-cancel').onclick = () => cancel();
  $('api-save').onclick = () => void save();
  $('api-test').onclick = () => void test();
  $('api-list').onclick = () => void listModels();
  $('api-remove-key').onclick = () => void removeKey();
  $('chatgpt-signin').onclick = () => void signIn();
  $('chatgpt-cancel').onclick = () => void cancelSignIn();
  $('chatgpt-signout').onclick = () => void signOut();
  $('openrouter-signin').onclick = () => void openRouterSignIn();
  $('openrouter-cancel').onclick = () => void cancelOpenRouter();

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
      if (!off)
        for (const id of [
          'chatgpt-signin',
          'chatgpt-cancel',
          'chatgpt-signout',
          'openrouter-signin',
          'openrouter-cancel',
        ])
          $(id).disabled = value;
    },
    active: () => view.active,
    connections: () => view.connections,
    models: () => listed,
  };
}
