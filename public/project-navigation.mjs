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
  showLibrary,
  onChange = () => {},
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
  /** A project opens in the library: its conversations, then its creations (0.5.123). */
  function openProject(project) {
    if (busy()) return;
    showLibrary({ project: project.id });
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
  // Deleting a project keeps its conversations: they go back to Conversations.
  let deleting = null;
  function remove(project) {
    if (busy() || project.id === 'inbox') return;
    closeMenu();
    deleting = project;
    const count = project.conversations?.filter(item => !item.temporary).length ?? 0;
    $('project-delete-title').textContent = `Supprimer le projet « ${project.name} » ?`;
    $('project-delete-description').textContent = count
      ? `${count > 1 ? `Ses ${count} conversations seront déplacées` : 'Sa conversation sera déplacée'} dans Conversations. Aucune conversation ni image n’est effacée.`
      : 'Ce projet est vide. Aucune conversation ni image n’est effacée.';
    $('project-delete-error').hidden = true;
    $('project-delete-confirm').disabled = false;
    $('project-delete-dialog').showModal();
  }
  $('project-delete-cancel').onclick = () => $('project-delete-dialog').close();
  dismissSettingsOnOutsideClick($('project-delete-dialog'));
  $('project-delete-confirm').onclick = async () => {
    if (working || !deleting) return;
    const project = deleting;
    working = true;
    state.projectWorking = true;
    onBusy();
    $('project-delete-confirm').disabled = true;
    try {
      const { moved = [] } = await (await api('projects/delete', { id: project.id, confirm: true })).json();
      const updated = new Map(moved.map(item => [item.id, item]));
      state.projects = state.projects.filter(item => item.id !== project.id);
      state.historyItems = state.historyItems.map(item => updated.get(item.id) || item);
      if (state.projectId === project.id) state.projectId = 'inbox';
      collapsed.delete(project.id);
      $('project-delete-dialog').close();
      render();
      onChange();
    } catch (error) {
      $('project-delete-error').textContent = error.message;
      $('project-delete-error').hidden = false;
      $('project-delete-confirm').disabled = false;
    } finally {
      working = false;
      state.projectWorking = false;
      onBusy();
      sync();
    }
  };

  // Right click on a project: rename or delete.
  let menu = null;
  const outside = event => {
    if (menu && !menu.contains(event.target)) closeMenu();
  };
  const escape = event => {
    if (event.key === 'Escape') closeMenu();
  };
  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('resize', closeMenu);
  }
  function openMenu(event, project) {
    event.preventDefault();
    if (busy()) return;
    closeMenu();
    menu = node('div', 'project-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Actions du projet ' + project.name);
    const item = (label, symbol, action, cls = '') => {
      const entry = node('button', 'project-menu-item ' + cls);
      entry.type = 'button';
      entry.setAttribute('role', 'menuitem');
      entry.append(icon(symbol), node('span', '', label));
      entry.onclick = () => {
        closeMenu();
        action();
      };
      return entry;
    };
    menu.append(item('Renommer', 'edit', () => edit(project)));
    if (project.id !== 'inbox') menu.append(item('Supprimer', 'trash', () => remove(project), 'is-danger'));
    document.body.append(menu);
    const width = menu.offsetWidth || 160,
      height = menu.offsetHeight || 80;
    menu.style.left = Math.min(event.clientX, window.innerWidth - width - 8) + 'px';
    menu.style.top = Math.min(event.clientY, window.innerHeight - height - 8) + 'px';
    menu.querySelector('button')?.focus();
    // Listening only while the menu is open: a click elsewhere, Escape or a resize closes it.
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  }
  /** Double click renames; right click opens the menu. */
  function projectGestures(element, project) {
    element.ondblclick = event => {
      event.preventDefault();
      edit(project);
    };
    element.oncontextmenu = event => openMenu(event, project);
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
      onChange();
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
      state.view === 'studio' ||
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
    // Chat and Studio are two views of the same conversation: it is the one open in both.
    const active = (state.view === 'chat' || state.view === 'studio') && item.id === state.conversationId,
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
        // The project at hand: that of the chat, or the one the library shows.
        const shown = state.view === 'library' && state.libraryProject === group.id,
          section = node(
            'section',
            'project-group' + ((state.view === 'chat' && state.projectId === group.id) || shown ? ' is-active' : ''),
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
        if (shown) open.setAttribute('aria-current', 'page');
        open.append(
          node('span', 'project-name', group.name),
          node('span', 'project-count', String(group.conversations.length)),
        );
        projectGestures(open, group);
        header.oncontextmenu = event => openMenu(event, group);
        header.append(toggle, open);
        if (group.id !== 'inbox')
          header.append(
            button('Supprimer ' + group.name, 'project-rename project-delete icon-button', () => remove(group), 'trash'),
          );
        children.hidden = !expanded;
        for (const item of group.conversations) {
          const row = conversationRow(item);
          children.append(row);
          if (revealDraft && item.temporary && group.id === state.projectId) draftRow = row;
        }
        if (!group.conversations.length) {
          const create = button(
            'Nouveau chat dans ' + group.name,
            'project-empty',
            () => newConversation(group.id),
            'plus',
          );
          create.append(node('span', '', 'Nouveau chat'));
          children.append(create);
        }
        section.append(header, children);
        list.append(section);
      }
      list.scrollTop = scrollTop;
      draftRow?.scrollIntoView?.({ block: 'nearest' });
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
    const select = $('conversation-project');
    select.replaceChildren();
    for (const project of state.projects || []) {
      const option = node('option', '', project.name);
      option.value = project.id;
      select.append(option);
    }
    select.value = state.projectId || 'inbox';
    $('chat-open')?.setAttribute('aria-current', state.view === 'chat' ? 'page' : 'false');
    $('studio-open').setAttribute('aria-current', state.view === 'studio' ? 'page' : 'false');
    $('library-open')?.setAttribute('aria-current', state.view === 'library' ? 'page' : 'false');
    $('studio-view').hidden = state.view !== 'studio';
    // The title bar of the window, the same in the Chat and the Studio; its pill in the Studio.
    $('chat-header').hidden = !['chat', 'studio'].includes(state.view);
    if ($('studio-pill')) $('studio-pill').hidden = state.view !== 'studio';
    document.body.dataset.view = state.view || 'chat';
    sync();
  }
  function sync() {
    for (const control of document.querySelectorAll(
      '.project-group button,#project-create,#conversation-project,#chat-open,#studio-open,#library-open',
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
