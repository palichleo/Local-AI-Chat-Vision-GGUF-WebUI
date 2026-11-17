import { dismissSettingsOnOutsideClick } from './settings-controls.mjs';

/**
 * The name a project is shown with. The conversations outside any project are « Sans projet »
 * (0.6.0), whatever the stored name of their group (« Conversations » before): nothing is renamed
 * in the data.
 */
export const projectLabel = project => (!project || project.id === 'inbox' ? 'Sans projet' : project.name);

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

/** « il y a 2 h », « hier », « 12 nov. » : when a conversation began, in the menu of the fil. */
export function shortDate(iso, now = new Date()) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const minutes = Math.floor((now - date) / 60000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const midnight = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 86400000);
  if (days <= 0) return `il y a ${Math.floor(minutes / 60)} h`;
  if (days === 1) return 'hier';
  return date
    .toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    })
    .replace(/\s+/g, ' ');
}

const plain = text =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
/** A title the search finds: its words, case and accents aside. */
export const titleFound = (title, query) => plain(title).includes(plain(query).trim());

/**
 * The fil « projet / conversation » (claude_design/maquettes, direction-artistique.md, 0.6.0): one
 * component in the Chat and the Studio, its two menus. The project: the list of projects, the
 * active one ticked, « Sans projet », « + Nouveau projet »; choosing one starts a conversation in
 * it (a conversation not begun yet just changes project, its draft kept). The conversation: those
 * of the project with a search, « + Nouvelle conversation » first, the newest first with their
 * date. A pencil and a bin on each line, under the pointer or the keyboard; deleting asks first.
 */
export function setupProjectNavigation({
  $,
  state,
  node,
  icon,
  api,
  openConversation,
  newConversation,
  removeConversation,
  setTitle = () => {},
  onChange = () => {},
  onBusy = () => {},
}) {
  let editing = null,
    working = false;
  const busy = () =>
    working ||
    state.savingHistory ||
    state.generating ||
    state.preparing ||
    state.loadingHistory ||
    state.updating ||
    state.closingApp ||
    !!state.status.toolJob;
  const projects = () => (state.projects?.length ? state.projects : [{ id: 'inbox', name: 'Conversations' }]);
  const currentProject = () => projects().find(project => project.id === (state.projectId || 'inbox')) ?? projects()[0];
  function button(label, cls, action, symbol) {
    const element = node('button', cls);
    element.type = 'button';
    element.setAttribute('aria-label', label);
    if (symbol) element.append(icon(symbol));
    element.onclick = action;
    element.disabled = !!busy();
    return element;
  }
  function edit(project = null) {
    if (busy()) return;
    closeMenus();
    editing = project;
    $('project-dialog-title').textContent = project ? 'Renommer le projet' : 'Nouveau projet';
    $('project-name').value = project?.name || '';
    $('project-error').hidden = true;
    $('project-dialog').showModal();
    $('project-name').focus();
  }
  // Deleting a project keeps its conversations: they go to « Sans projet ».
  let deleting = null;
  function remove(project) {
    if (busy() || project.id === 'inbox') return;
    closeMenus();
    deleting = project;
    const count = state.historyItems?.filter(item => (item.projectId || 'inbox') === project.id).length ?? 0;
    $('project-delete-title').textContent = `Supprimer le projet « ${project.name} » ?`;
    $('project-delete-description').textContent = count
      ? `${count > 1 ? `Ses ${count} conversations seront déplacées` : 'Sa conversation sera déplacée'} dans « Sans projet », avec leurs prises. Aucune conversation ni prise n’est effacée.`
      : 'Ce projet est vide. Aucune conversation ni prise n’est effacée.';
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

  $('project-cancel').onclick = () => $('project-dialog').close();
  dismissSettingsOnOutsideClick($('project-dialog'));
  $('project-form').onsubmit = async event => {
    event.preventDefault();
    if (working) return;
    const creating = !editing;
    working = true;
    state.projectWorking = true;
    onBusy();
    $('project-save').disabled = true;
    $('project-error').hidden = true;
    let created = null;
    try {
      const { project } = await (
        await api('projects/save', { ...(editing ? { id: editing.id } : {}), name: $('project-name').value })
      ).json();
      // Renamed, a project keeps its place, as on the server: put last, it went back to it at the next
      // launch. Only a new one is added.
      state.projects = state.projects.some(item => item.id === project.id)
        ? state.projects.map(item => (item.id === project.id ? project : item))
        : state.projects.concat(project);
      $('project-dialog').close();
      if (creating) created = project;
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
    // A project made from the fil is the one chosen: the conversation goes into it.
    if (created) choose(created);
  };

  /** A project chosen in the fil: a new conversation in it, or the one not begun yet moved there. */
  function choose(project) {
    if (busy()) return;
    closeMenus();
    const begun = state.conversationId || state.messages?.length;
    if (!begun) {
      state.projectId = project.id;
      render();
      onChange();
      return;
    }
    if (project.id === (state.projectId || 'inbox')) return;
    newConversation(project.id);
  }

  /** The projects in the order of the fil: those of the user, then « Sans projet ». */
  const ordered = () => [
    ...projects().filter(project => project.id !== 'inbox'),
    ...projects().filter(project => project.id === 'inbox'),
  ];
  // The conversation dialog: its name and its project (moving it is done here since 0.6.0), the
  // project a menu in the order of the fil.
  let conversationEditing = null;
  function editConversation(item) {
    if (busy() || item.temporary) return;
    closeMenus();
    conversationEditing = item;
    $('conversation-name').value = item.title || '';
    const select = $('conversation-project');
    select.replaceChildren(
      ...ordered().map(project => {
        const option = node('option', '', projectLabel(project));
        option.value = project.id;
        return option;
      }),
    );
    select.value = item.projectId || 'inbox';
    select.onchange = () => void previewTakes(item);
    paintPicker();
    openPicker(false);
    $('conversation-takes').hidden = true;
    $('conversation-error').hidden = true;
    $('conversation-save').disabled = false;
    $('conversation-dialog').showModal();
    $('conversation-name').focus();
  }
  /**
   * Before a move, under the menu: the numbers its takes would take in the project chosen (they
   * follow its counter), so that a change of numbers does not surprise.
   */
  async function previewTakes(item) {
    const line = $('conversation-takes'),
      project = $('conversation-project').value || 'inbox';
    line.hidden = true;
    if (project === (item.projectId || 'inbox')) return;
    try {
      const { count, first, last } = await (
        await api(`takes/preview?conversation=${encodeURIComponent(item.id)}&project=${encodeURIComponent(project)}`)
      ).json();
      if (conversationEditing !== item || $('conversation-project').value !== project || !count) return;
      const name = `« ${projectLabel(projects().find(entry => entry.id === project))} »`;
      line.textContent =
        count === 1
          ? `Sa prise prendra le numéro ${first} dans ${name}.`
          : `Ses ${count} prises prendront les numéros ${first} à ${last} dans ${name}.`;
      line.hidden = false;
    } catch {
      // Without the numbers, the move is still possible.
    }
  }
  /**
   * « Projet » in the window of the pencil (16/11): a menu as those of the fil, not the menu of the
   * browser. The projects in the order of the fil, the one of the conversation marked; one chosen
   * goes in the hidden select (what the window saves), and the line of the numbers says what its
   * takes would become there.
   */
  function paintPicker() {
    const select = $('conversation-project'),
      chosen = ordered().find(project => project.id === select.value) ?? ordered()[0];
    $('conversation-project-name').textContent = chosen ? projectLabel(chosen) : '';
  }
  function openPicker(open) {
    const list = $('conversation-project-menu'),
      toggle = $('conversation-project-button'),
      select = $('conversation-project');
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) return;
    list.replaceChildren(
      ...ordered().map(project => {
        const current = project.id === select.value,
          row = node('div', 'thread-line' + (current ? ' is-current' : '')),
          pick = node('button', 'thread-choice');
        pick.type = 'button';
        pick.setAttribute('role', 'option');
        pick.setAttribute('aria-selected', String(current));
        pick.append(node('span', 'thread-choice-name', projectLabel(project)));
        pick.onclick = () => {
          select.value = project.id;
          paintPicker();
          openPicker(false);
          toggle.focus();
          void select.onchange?.();
        };
        row.append(pick);
        return row;
      }),
    );
    (list.querySelector?.('.is-current .thread-choice') ?? list.querySelector?.('.thread-choice'))?.focus?.();
  }
  $('conversation-project-button').onclick = () => openPicker($('conversation-project-menu').hidden);
  $('conversation-project-menu').onkeydown = event => {
    if (event.key === 'Escape') {
      // The menu closes, not the window.
      event.preventDefault();
      event.stopPropagation();
      openPicker(false);
      $('conversation-project-button').focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...$('conversation-project-menu').querySelectorAll('.thread-choice')];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement),
      step = event.key === 'ArrowDown' ? 1 : -1;
    items[at === -1 ? 0 : (at + step + items.length) % items.length].focus();
  };
  // A click elsewhere in the window closes the menu.
  $('conversation-dialog').addEventListener('pointerdown', event => {
    if (!$('conversation-project-menu').hidden && !event.target?.closest?.('.project-picker')) openPicker(false);
  });
  $('conversation-dialog').addEventListener('close', () => openPicker(false));
  $('conversation-cancel').onclick = () => $('conversation-dialog').close();
  dismissSettingsOnOutsideClick($('conversation-dialog'));
  $('conversation-form').onsubmit = async event => {
    event.preventDefault();
    if (working || !conversationEditing) return;
    const item = conversationEditing,
      title = $('conversation-name').value.trim().replace(/\s+/g, ' '),
      projectId = $('conversation-project').value || 'inbox';
    working = true;
    state.projectWorking = true;
    onBusy();
    $('conversation-save').disabled = true;
    $('conversation-error').hidden = true;
    try {
      let saved = item;
      if (title && title !== item.title)
        saved = (await (await api('history/rename', { id: item.id, title })).json()).conversation;
      if (projectId !== (item.projectId || 'inbox'))
        saved = (await (await api('projects/move', { id: item.id, projectId })).json()).conversation;
      state.historyItems = state.historyItems.map(entry => (entry.id === item.id ? saved : entry));
      if (item.id === state.conversationId) {
        state.projectId = saved.projectId || 'inbox';
        setTitle(saved.title);
      }
      $('conversation-dialog').close();
      render();
      onChange();
    } catch (error) {
      $('conversation-error').textContent = error.message;
      $('conversation-error').hidden = false;
    } finally {
      working = false;
      state.projectWorking = false;
      onBusy();
      $('conversation-save').disabled = false;
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

  // ---------------------------------------------------------------- the two menus of the fil
  let menu = null,
    opener = null;
  const outside = event => {
    if (menu && !menu.contains(event.target) && !opener?.contains(event.target)) closeMenus();
  };
  function keys(event) {
    if (!menu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenus({ refocus: true });
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...menu.querySelectorAll('input, button:not(:disabled)')].filter(
      item => !item.closest('[hidden]'),
    );
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement),
      step = event.key === 'ArrowDown' ? 1 : -1;
    items[at === -1 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length].focus();
  }
  const resized = () => closeMenus();
  function closeMenus({ refocus = false } = {}) {
    if (!menu) return;
    menu.remove();
    menu = null;
    opener?.setAttribute('aria-expanded', 'false');
    if (refocus) opener?.focus?.();
    opener = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
    window.removeEventListener('resize', resized);
    window.removeEventListener('blur', resized);
  }
  /** Under its button, at its left edge; above it when the window is too low. */
  function place(list, anchor) {
    document.body.append(list);
    const box = anchor.getBoundingClientRect(),
      width = list.offsetWidth || 280,
      height = list.offsetHeight || 200,
      room = window.innerHeight || 800;
    let top = box.bottom + 8;
    if (top + height > room - 8) top = Math.max(8, box.top - height - 8);
    list.style.left = Math.max(8, Math.min(box.left, (window.innerWidth || 1280) - width - 8)) + 'px';
    list.style.top = top + 'px';
  }
  function open(list, anchor) {
    closeMenus();
    menu = list;
    opener = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    place(list, anchor);
    list.addEventListener('focusout', event => {
      if (menu === list && event.relatedTarget && !list.contains(event.relatedTarget)) closeMenus();
    });
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keys, true);
    window.addEventListener('resize', resized);
    window.addEventListener('blur', resized);
  }
  /** A line of a menu: its choice, and its pencil and bin (under the pointer or the keyboard). */
  function line(label, { current = false, date = '', choose: action, rename, remove: erase, kind }) {
    const row = node('div', 'thread-line' + (current ? ' is-current' : ''));
    const pick = node('button', 'thread-choice');
    pick.type = 'button';
    pick.append(node('span', 'thread-choice-name', label));
    if (date) pick.append(node('span', 'thread-choice-date', date));
    const tick = icon('check');
    tick.classList.add('thread-tick');
    pick.append(tick);
    if (current) pick.setAttribute('aria-current', 'true');
    pick.onclick = action;
    pick.disabled = !!busy();
    row.append(pick);
    const tools = node('span', 'thread-tools');
    if (rename) {
      // A conversation is renamed or moved to another project from the same pencil.
      const both = kind === 'la conversation',
        pencil = button(`${both ? 'Renommer ou déplacer' : 'Renommer'} ${kind} « ${label} »`, 'thread-tool', rename, 'edit');
      pencil.dataset.tip = both ? 'Renommer ou déplacer' : 'Renommer';
      tools.append(pencil);
    }
    if (erase) {
      const bin = button(`Supprimer ${kind} « ${label} »`, 'thread-tool is-danger', erase, 'trash');
      bin.dataset.tip = 'Supprimer';
      tools.append(bin);
    }
    if (tools.children.length) row.append(tools);
    return row;
  }
  function action(label, symbol, run) {
    const item = node('button', 'thread-action');
    item.type = 'button';
    item.append(icon(symbol), node('span', '', label));
    item.onclick = run;
    item.disabled = !!busy();
    return item;
  }
  function projectMenu() {
    const list = node('div', 'thread-menu');
    list.setAttribute('role', 'dialog');
    list.setAttribute('aria-label', 'Projets');
    list.append(node('p', 'thread-menu-label', 'Projets'));
    const active = currentProject()?.id;
    // The projects first, « Sans projet » last.
    for (const project of ordered())
      list.append(
        line(projectLabel(project), {
          kind: 'le projet',
          current: project.id === active,
          choose: () => choose(project),
          ...(project.id === 'inbox' ? {} : { rename: () => edit(project), remove: () => remove(project) }),
        }),
      );
    list.append(node('hr', 'thread-rule'), action('Nouveau projet', 'plus', () => edit()));
    return list;
  }
  function conversationMenu() {
    const list = node('div', 'thread-menu is-conversations'),
      project = currentProject(),
      label = projectLabel(project);
    list.setAttribute('role', 'dialog');
    list.setAttribute('aria-label', 'Conversations · ' + label);
    const head = node('div', 'thread-menu-head');
    head.append(node('p', 'thread-menu-label', 'Conversations'), node('span', 'thread-menu-project', label));
    const search = node('label', 'thread-search'),
      field = node('input');
    field.type = 'search';
    field.placeholder = 'Rechercher…';
    field.autocomplete = 'off';
    field.setAttribute('aria-label', 'Rechercher une conversation');
    search.append(icon('search'), field);
    const rows = node('div', 'thread-lines'),
      empty = node('p', 'thread-empty', 'Aucune conversation');
    const group = projectGroups(projects(), entries()).find(item => item.id === project?.id);
    const items = (group?.conversations ?? []).filter(
      item => !item.temporary || (item.title && item.title !== 'Nouvelle conversation' && item.title !== 'Nouveau chat'),
    );
    for (const item of items) {
      const row = line(item.title, {
        kind: 'la conversation',
        // Chat and Studio are two views of the same conversation: it is the one open in both.
        current: (state.view === 'chat' || state.view === 'studio') && item.id === state.conversationId,
        date: item.temporary ? '' : shortDate(item.createdAt || item.updatedAt),
        choose: () => {
          closeMenus();
          openConversation(item.id);
        },
        ...(item.temporary || !state.saveHistory
          ? {}
          : { rename: () => editConversation(item), remove: () => (closeMenus(), removeConversation(item)) }),
      });
      row.dataset.title = item.title;
      rows.append(row);
    }
    empty.hidden = items.length > 0;
    field.oninput = () => {
      let shown = 0;
      for (const row of rows.children) {
        row.hidden = !titleFound(row.dataset.title, field.value);
        if (!row.hidden) shown++;
      }
      empty.hidden = shown > 0;
    };
    list.append(
      head,
      search,
      action('Nouvelle conversation', 'plus', () => {
        closeMenus();
        newConversation(state.projectId || 'inbox');
      }),
      node('hr', 'thread-rule'),
      rows,
      empty,
    );
    return list;
  }
  $('thread-project').onclick = () => {
    if (menu && opener === $('thread-project')) return closeMenus();
    if (busy()) return;
    open(projectMenu(), $('thread-project'));
    menu.querySelector('.thread-line.is-current .thread-choice, .thread-choice')?.focus();
  };
  $('thread-conversation').onclick = () => {
    if (menu && opener === $('thread-conversation')) return closeMenus();
    if (busy()) return;
    open(conversationMenu(), $('thread-conversation'));
    menu.querySelector('input')?.focus();
  };
  // A right click on the project: rename it or delete it at once, a shortcut of its menu.
  $('thread-project').oncontextmenu = event => {
    event.preventDefault();
    const project = currentProject();
    if (busy() || !project || project.id === 'inbox') return;
    const list = node('div', 'thread-menu is-small');
    list.setAttribute('role', 'dialog');
    list.setAttribute('aria-label', 'Actions du projet ' + project.name);
    list.append(action('Renommer', 'edit', () => edit(project)), action('Supprimer le projet', 'trash', () => remove(project)));
    list.lastChild.classList.add('is-danger');
    open(list, $('thread-project'));
    list.querySelector('button')?.focus();
  };

  /**
   * « Reprendre », at the foot of the welcome (direction-artistique.md): its button opens the last
   * conversation of the project, and up to three recent ones stand beside it, each with its date.
   * Everything opens in the Chat.
   */
  function renderResume() {
    const project = currentProject()?.id || 'inbox',
      recent = (state.saveHistory ? state.historyItems || [] : [])
        .filter(item => (item.projectId || 'inbox') === project && item.id !== state.conversationId)
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
        .slice(0, 3);
    $('resume-list').replaceChildren(
      ...recent.map(item => {
        const open = node('button', 'resume-item'),
          date = shortDate(item.updatedAt || item.createdAt);
        open.type = 'button';
        open.append(node('span', 'resume-title', item.title), node('span', 'resume-date', date));
        open.setAttribute('aria-label', `${item.title}, ${date}`);
        open.onclick = () => openConversation(item.id);
        open.disabled = !!busy();
        return open;
      }),
    );
    $('resume-last').onclick = () => recent[0] && openConversation(recent[0].id);
    $('resume-last').disabled = !!busy() || !recent.length;
    $('resume').hidden = !recent.length;
  }
  function render() {
    closeMenus();
    renderResume();
    const project = currentProject();
    $('thread-project-name').textContent = projectLabel(project);
    $('thread-project').setAttribute('aria-label', 'Projet : ' + projectLabel(project));
    $('thread-conversation').setAttribute('aria-label', 'Conversation : ' + $('conversation-title').textContent);
    $('chat-open')?.setAttribute('aria-current', state.view === 'chat' ? 'page' : 'false');
    $('studio-open').setAttribute('aria-current', state.view === 'studio' ? 'page' : 'false');
    $('library-open')?.setAttribute('aria-current', state.view === 'library' ? 'page' : 'false');
    $('studio-view').hidden = state.view !== 'studio';
    // The fil, the same in the Chat and the Studio; the Pellicule has its own title.
    $('thread').hidden = !['chat', 'studio'].includes(state.view || 'chat');
    document.body.dataset.view = state.view || 'chat';
    sync();
  }
  function sync() {
    for (const control of document.querySelectorAll('#thread button,#chat-open,#studio-open,#library-open'))
      control.disabled = !!busy();
  }
  async function refresh() {
    const result = await (await api('projects')).json();
    state.projects = result.projects;
    render();
  }
  return { render, refresh, sync, closeMenus, edit, remove, renderResume };
}
