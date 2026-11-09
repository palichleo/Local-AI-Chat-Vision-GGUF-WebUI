import { dismissSettingsOnOutsideClick } from './settings-controls.mjs';

export function projectGroups(projects, conversations) {
  const groups = projects.map(project => ({ ...project, conversations: [] })),
    byId = new Map(groups.map(project => [project.id, project]));
  for (const conversation of conversations)
    (byId.get(conversation.projectId) || byId.get('inbox'))?.conversations.push(conversation);
  for (const group of groups)
    group.conversations.sort(
      (a, b) =>
        Number(b.temporary === true) - Number(a.temporary === true) ||
        (b.createdAt || b.updatedAt || '').localeCompare(a.createdAt || a.updatedAt || '') ||
        (a.id || '').localeCompare(b.id || ''),
    );
  return groups;
}

export function setupProjectNavigation({
  $,
  state,
  node,
  icon,
  api,
  notice,
  openConversation,
  newConversation,
  removeConversation,
  showHome,
  onBusy = () => {},
}) {
  const collapsed = new Set();
  let editing = null,
    working = false,
    draftProject = null;
  const busy = () =>
    working ||
    state.savingHistory ||
    state.generating ||
    state.preparing ||
    state.loadingHistory ||
    state.updating ||
    state.closingApp ||
    !!state.status.toolJob;
  const date = value => (value ? new Date(value).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '');
  function button(label, cls, action, symbol) {
    const element = node('button', cls);
    element.type = 'button';
    element.title = label;
    element.setAttribute('aria-label', label);
    if (symbol) element.append(icon(symbol));
    element.onclick = action;
    element.disabled = !!busy();
    return element;
  }
  function openProject(project) {
    if (busy()) return;
    const recent = project.conversations[0];
    if (recent) openConversation(recent.id);
    else newConversation(project.id);
  }
  function edit(project = null) {
    if (busy()) return;
    editing = project;
    $('project-dialog-title').textContent = project ? 'Renommer le projet' : 'Nouveau projet';
    $('project-name').value = project?.name || '';
    $('project-error').hidden = true;
    $('project-dialog').showModal();
    $('project-name').focus();
  }
  $('project-cancel').onclick = () => $('project-dialog').close();
  dismissSettingsOnOutsideClick($('project-dialog'));
  $('project-form').onsubmit = async event => {
    event.preventDefault();
    if (working) return;
    working = true;
    state.projectWorking = true;
    onBusy();
    $('project-save').disabled = true;
    $('project-error').hidden = true;
    try {
      const { project } = await (
        await api('projects/save', { ...(editing ? { id: editing.id } : {}), name: $('project-name').value })
      ).json();
      state.projects = state.projects.filter(item => item.id !== project.id).concat(project);
      $('project-dialog').close();
      render();
    } catch (error) {
      $('project-error').textContent = error.message;
      $('project-error').hidden = false;
    } finally {
      working = false;
      state.projectWorking = false;
      onBusy();
      $('project-save').disabled = false;
      sync();
    }
  };
  $('project-create').onclick = () => edit();
  $('home-create-project').onclick = () => edit();
  $('home-open').onclick = () => showHome();
  $('brand-home').onclick = event => {
    event.preventDefault();
    showHome();
  };
  $('conversation-project').onchange = async () => {
    const previous = state.projectId,
      next = $('conversation-project').value;
    if (busy()) {
      $('conversation-project').value = previous;
      return;
    }
    working = true;
    state.projectWorking = true;
    onBusy();
    sync();
    try {
      const saved = state.historyItems.find(item => item.id === state.conversationId);
      if (saved) {
        const { conversation } = await (await api('projects/move', { id: saved.id, projectId: next })).json();
        state.historyItems = state.historyItems.map(item => (item.id === saved.id ? conversation : item));
      }
      state.projectId = next;
      collapsed.delete(next);
      render();
    } catch (error) {
      notice(error.message);
      $('conversation-project').value = previous;
    } finally {
      working = false;
      state.projectWorking = false;
      onBusy();
      sync();
    }
  };
  function entries() {
    const result = state.saveHistory ? [...state.historyItems] : [];
    const currentOpen =
      state.view === 'chat' ||
      state.conversationId ||
      state.messages?.length ||
      state.images?.length ||
      $('prompt').value?.trim();
    if (currentOpen && !result.some(item => item.id === state.conversationId))
      result.unshift({
        id: state.conversationId,
        title: $('conversation-title').textContent,
        projectId: state.projectId,
        temporary: true,
      });
    return result;
  }
  function conversationRow(item) {
    const active = state.view === 'chat' && item.id === state.conversationId,
      row = node('div', 'history-row');
    const open = button(
      item.title,
      'history-item' + (active ? ' active' : ''),
      () => openConversation(item.id),
      'chat',
    );
    open.dataset.conversationId = item.id || '';
    open.dataset.current = String(active);
    if (active) open.setAttribute('aria-current', 'page');
    const label = node('span', 'history-label');
    label.append(node('span', 'history-title', item.title));
    open.append(label);
    row.append(open);
    if (!item.temporary && state.saveHistory) {
      const remove = button(
        'Supprimer la conversation : ' + item.title,
        'history-delete-button icon-button',
        () => removeConversation(item),
        'trash',
      );
      row.append(remove);
    }
    return row;
  }
  function renderSidebar(groups, revealDraft) {
    for (const id of ['history-list', 'history-list-mobile']) {
      const list = $(id),
        scrollTop = list.scrollTop;
      let draftRow;
      list.replaceChildren();
      for (const group of groups) {
        const section = node(
            'section',
            'project-group' + (state.view === 'chat' && state.projectId === group.id ? ' is-active' : ''),
          ),
          header = node('div', 'project-row'),
          children = node('div', 'project-conversations');
        const expanded = !collapsed.has(group.id),
          toggle = button(
            (expanded ? 'Replier ' : 'Déplier ') + group.name,
            'project-toggle icon-button',
            () => {
              if (collapsed.has(group.id)) collapsed.delete(group.id);
              else collapsed.add(group.id);
              render();
            },
            'chevron',
          );
        toggle.setAttribute('aria-expanded', String(expanded));
        children.id = id + '-' + group.id;
        toggle.setAttribute('aria-controls', children.id);
        const open = button(group.name, 'project-open', () => openProject(group), 'folder');
        open.append(
          node('span', 'project-name', group.name),
          node('span', 'project-count', String(group.conversations.length)),
        );
        const rename = button('Renommer ' + group.name, 'project-rename icon-button', () => edit(group), 'edit');
        header.append(toggle, open, rename);
        children.hidden = !expanded;
        for (const item of group.conversations) {
          const row = conversationRow(item);
          children.append(row);
          if (revealDraft && item.temporary && group.id === state.projectId) draftRow = row;
        }
        if (!group.conversations.length) {
          const create = button(
            'Nouvelle conversation dans ' + group.name,
            'project-empty',
            () => newConversation(group.id),
            'plus',
          );
          create.append(node('span', '', 'Nouvelle conversation'));
          children.append(create);
        }
        section.append(header, children);
        list.append(section);
      }
      list.scrollTop = scrollTop;
      draftRow?.scrollIntoView?.({ block: 'nearest' });
    }
  }
  function renderHome(groups) {
    const grid = $('project-grid');
    grid.replaceChildren();
    const total = state.historyItems.length;
    $('home-summary').textContent =
      groups.length +
      ' projet' +
      (groups.length > 1 ? 's' : '') +
      ' · ' +
      total +
      ' conversation' +
      (total > 1 ? 's' : '');
    for (const group of groups) {
      const conversations = group.conversations.filter(item => !item.temporary),
        visual = conversations.find(item => item.previewUrl),
        card = node('article', 'project-card' + (visual ? ' is-visual' : ''));
      if (visual) {
        const cover = button('Reprendre ' + visual.title, 'project-cover', () => openConversation(visual.id));
        const image = node('img');
        image.alt = 'Aperçu de ' + group.name;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.src = visual.previewUrl;
        image.onerror = () => {
          cover.hidden = true;
          card.classList.remove('is-visual');
        };
        cover.append(image, node('span', 'project-cover-label', 'Dernier visuel'));
        card.append(cover);
      }
      const head = node('div', 'project-card-heading'),
        title = button(group.name, 'project-card-title', () => openProject(group), 'folder');
      title.append(node('h2', '', group.name));
      const rename = button('Renommer ' + group.name, 'icon-button project-card-rename', () => edit(group), 'edit');
      head.append(title, rename);
      card.append(
        head,
        node(
          'p',
          'project-card-meta',
          conversations.length +
            ' conversation' +
            (conversations.length > 1 ? 's' : '') +
            (visual ? ' · Visuel' : ' · Texte'),
        ),
      );
      const list = node('div', 'project-recent');
      for (const item of conversations.slice(0, 10)) {
        const row = button(item.firstPrompt || item.title, 'project-recent-item', () => openConversation(item.id));
        row.append(
          node('span', '', item.firstPrompt || item.title),
          node('time', '', date(item.createdAt || item.updatedAt)),
        );
        list.append(row);
      }
      if (!conversations.length) list.append(node('p', 'project-card-empty', 'Votre prochaine idée commence ici.'));
      const footer = node('div', 'project-card-footer'),
        create = button(
          'Nouvelle conversation dans ' + group.name,
          'project-card-new',
          () => newConversation(group.id),
          'plus',
        );
      create.append(node('span', '', 'Nouvelle conversation'));
      footer.append(create);
      card.append(list, footer);
      grid.append(card);
    }
  }
  function render() {
    const nextDraft = state.view === 'chat' && !state.conversationId ? state.projectId : null,
      revealDraft = nextDraft !== null && nextDraft !== draftProject;
    draftProject = nextDraft;
    if (revealDraft) collapsed.delete(nextDraft);
    const groups = projectGroups(state.projects || [{ id: 'inbox', name: 'Conversations' }], entries());
    $('history-section').hidden = false;
    $('history-mobile').hidden = !state.saveHistory;
    renderSidebar(groups, revealDraft);
    if (state.view === 'home') renderHome(groups);
    const select = $('conversation-project');
    select.replaceChildren();
    for (const project of state.projects || []) {
      const option = node('option', '', project.name);
      option.value = project.id;
      select.append(option);
    }
    select.value = state.projectId || 'inbox';
    $('home-open').setAttribute('aria-current', state.view === 'home' ? 'page' : 'false');
    $('home-view').hidden = state.view !== 'home';
    $('chat-header').hidden = state.view === 'home';
    document.body.dataset.view = state.view || 'home';
    sync();
  }
  function sync() {
    for (const control of document.querySelectorAll(
      '.project-group button,.project-card button,#project-create,#home-create-project,#conversation-project,#home-open',
    ))
      control.disabled = !!busy();
  }
  async function refresh() {
    const result = await (await api('projects')).json();
    state.projects = result.projects;
    render();
  }
  return { render, refresh, sync };
}
