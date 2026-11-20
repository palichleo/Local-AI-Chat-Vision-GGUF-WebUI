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
 * In the Pellicule (pellicule-fil-maquette.md, captures 35 to 39), the same fil heads the sheet
 * (`useLibrary`): « Tous les projets » alone, or « test / Toutes les conversations »; its menus say
 * the takes of each line and choose what the sheet shows, they open nothing.
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
  // Why a move or a deletion is refused now, said where it is refused (0.6.81).
  notice = () => {},
}) {
  let editing = null,
    working = false;
  /**
   * Going from page to page, from a conversation or a project to another (0.6.81): never held by a
   * work of Moodix or of the Studio (its conversation keeps it, the miniature shows it); only by what
   * changes the page itself, and by the few seconds Moodix AI sets the Studio on screen.
   */
  const moving = () =>
    working ||
    state.preparing ||
    state.loadingHistory ||
    state.updating ||
    state.closingApp ||
    Boolean(state.studio?.settingUp?.());
  // Moving a conversation to another project, deleting one or a project: not while a work goes on
  // (its take would be written in a conversation gone, or numbered in the project it left; the
  // server refuses while a generation runs or Moodix answers).
  const busy = () => moving() || state.savingHistory || state.generating || !!state.status.toolJob || Boolean(state.work);
  const HELD = 'Pendant une génération, une conversation ou un projet ne peut être ni déplacé ni supprimé : attendez sa fin.';
  const projects = () => (state.projects?.length ? state.projects : [{ id: 'inbox', name: 'Conversations' }]);
  const currentProject = () => projects().find(project => project.id === (state.projectId || 'inbox')) ?? projects()[0];
  // The Pellicule, once it is there (`useLibrary`): its filter and its numbers of takes. The fil is
  // its own while it is on screen.
  let library = null,
    home = null;
  const shelf = () => (state.view === 'library' && library ? library : null);
  /** The project the fil says: the one of the conversation, or the one the Pellicule shows (none: all). */
  const shownProject = () => {
    const shown = shelf();
    if (!shown) return currentProject();
    const id = shown.filter().project;
    return id === 'all' ? null : (projects().find(project => project.id === id) ?? null);
  };
  /** A line of a menu chosen in the Pellicule: the sheet narrowed, nothing opened. */
  function narrow(change) {
    if (moving() || !library) return;
    closeMenus();
    library.choose(change);
  }
  /** `locked`: what greys it (moving by default; `busy` for what moves or deletes). */
  function button(label, cls, action, symbol, locked = moving) {
    const element = node('button', cls);
    element.type = 'button';
    element.setAttribute('aria-label', label);
    if (symbol) element.append(icon(symbol));
    element.onclick = action;
    element.disabled = !!locked();
    return element;
  }
  function edit(project = null) {
    if (moving()) return;
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
    if (project.id === 'inbox' || moving()) return;
    // A menu open before the work began: refused in words.
    if (busy()) return notice(HELD);
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
      // The conversation set aside too (0.6.87): taken back, its next save put it in a project gone.
      if (state.aside?.projectId === project.id) state.aside.projectId = updated.get(state.aside.conversationId)?.projectId || 'inbox';
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
    if (moving()) return;
    closeMenus();
    // In the Pellicule, the project shown.
    if (shelf()) return void narrow({ project: project.id });
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
    if (moving() || item.temporary) return;
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
    // Renamed during a work, not moved (0.6.81): its project stays, and the line under it says why.
    const held = busy();
    $('conversation-project-button').disabled = held;
    if (held) {
      $('conversation-takes').textContent = 'Pendant une génération, une conversation ne change pas de projet.';
      $('conversation-takes').hidden = false;
    }
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
    // A work began since the window opened (0.6.81): the name is kept, not the move.
    if (projectId !== (item.projectId || 'inbox') && busy()) {
      $('conversation-error').textContent = HELD;
      $('conversation-error').hidden = false;
      return;
    }
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
      // The conversation set aside, moved from the fil while another is shown (0.6.87): taken back,
      // its next save put it back in the project it had left.
      if (item.id === state.aside?.conversationId) {
        state.aside.projectId = saved.projectId || 'inbox';
        state.aside.title = saved.title;
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
    // Without the history, the one set aside too (0.6.103): only its miniature led back to it, none
    // after an update or « Redémarrer ».
    const aside = state.aside;
    if (aside?.conversationId && !result.some(item => item.id === aside.conversationId))
      result.push({ id: aside.conversationId, title: aside.title || 'Conversation mise de côté', projectId: aside.projectId || 'inbox', temporary: true });
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
  /**
   * A line of a menu: its choice, and its pencil and bin (under the pointer or the keyboard). In
   * the Pellicule, its number of takes at its right (`count`), which stays beside them.
   */
  function line(label, { current = false, date = '', count = null, choose: action, rename, remove: erase, kind }) {
    const row = node('div', 'thread-line' + (current ? ' is-current' : '') + (count === null ? '' : ' has-count'));
    const pick = node('button', 'thread-choice');
    pick.type = 'button';
    pick.append(node('span', 'thread-choice-name', label));
    if (date) pick.append(node('span', 'thread-choice-date', date));
    if (count === null) {
      const tick = icon('check');
      tick.classList.add('thread-tick');
      pick.append(tick);
    } else pick.append(node('span', 'thread-choice-count', String(count)));
    if (current) pick.setAttribute('aria-current', 'true');
    pick.onclick = action;
    pick.disabled = !!moving();
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
      // Greyed during a work (0.6.81), the reason under the pointer.
      const bin = button(`Supprimer ${kind} « ${label} »`, 'thread-tool is-danger', erase, 'trash', busy);
      bin.dataset.tip = bin.disabled && !moving() ? HELD : 'Supprimer';
      tools.append(bin);
    }
    if (tools.children.length) row.append(tools);
    return row;
  }
  /** `locked`: what greys it (moving by default; `busy` for what deletes). */
  function action(label, symbol, run, locked = moving) {
    const item = node('button', 'thread-action');
    item.type = 'button';
    item.append(icon(symbol), node('span', '', label));
    item.onclick = run;
    item.disabled = !!locked();
    return item;
  }
  function projectMenu() {
    const shown = shelf(),
      list = node('div', 'thread-menu' + (shown ? ' is-shelf' : '')),
      // A long list scrolls, « + Nouveau projet » stays under it.
      rows = node('div', 'thread-lines');
    list.setAttribute('role', 'dialog');
    list.setAttribute('aria-label', 'Projets');
    const active = shown ? shown.filter().project : currentProject()?.id;
    // In the Pellicule (capture 36): « Tous les projets » first, each line with its number of takes.
    if (shown)
      list.append(
        line('Tous les projets', { current: active === 'all', count: shown.count(), choose: () => narrow({ project: 'all' }) }),
        node('hr', 'thread-rule'),
      );
    else list.append(node('p', 'thread-menu-label', 'Projets'));
    // The projects first, « Sans projet » last.
    for (const project of ordered())
      rows.append(
        line(projectLabel(project), {
          kind: 'le projet',
          current: project.id === active,
          ...(shown ? { count: shown.count({ project: project.id }) } : {}),
          choose: () => choose(project),
          ...(project.id === 'inbox' ? {} : { rename: () => edit(project), remove: () => remove(project) }),
        }),
      );
    list.append(rows, node('hr', 'thread-rule'), action('Nouveau projet', 'plus', () => edit()));
    return list;
  }
  /**
   * The conversations in the Pellicule (capture 38): « Toutes les conversations » first, then those
   * of the project that made takes, each with its number; one chosen narrows the sheet (the Chat
   * does not open). « + Nouvelle conversation » at the foot opens the welcome in this project.
   */
  function shelfMenu(shown) {
    const { project, conversation } = shown.filter(),
      list = node('div', 'thread-menu is-conversations is-shelf'),
      rows = node('div', 'thread-lines');
    list.setAttribute('role', 'dialog');
    list.setAttribute('aria-label', 'Conversations · ' + projectLabel(shownProject()));
    list.append(
      line('Toutes les conversations', {
        current: conversation === 'all',
        count: shown.count({ project }),
        choose: () => narrow({ conversation: 'all' }),
      }),
      node('hr', 'thread-rule'),
    );
    const group = projectGroups(projects(), state.historyItems || []).find(item => item.id === project);
    for (const item of group?.conversations ?? []) {
      // Those without a take, of any kind, have nothing to show here.
      if (!shown.count({ project, conversation: item.id, media: 'all' })) continue;
      rows.append(
        line(item.title, {
          kind: 'la conversation',
          current: item.id === conversation,
          count: shown.count({ project, conversation: item.id }),
          choose: () => narrow({ conversation: item.id }),
          ...(state.saveHistory
            ? { rename: () => editConversation(item), remove: () => (closeMenus(), removeConversation(item)) }
            : {}),
        }),
      );
    }
    list.append(
      rows,
      node('hr', 'thread-rule'),
      action('Nouvelle conversation', 'plus', () => {
        closeMenus();
        newConversation(project);
      }),
    );
    return list;
  }
  function conversationMenu() {
    if (shelf()) return shelfMenu(shelf());
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
    if (moving()) return;
    open(projectMenu(), $('thread-project'));
    // The line chosen, even far down a list that scrolls; else the first.
    (menu.querySelector('.thread-line.is-current .thread-choice') ?? menu.querySelector('.thread-choice'))?.focus();
  };
  $('thread-conversation').onclick = () => {
    if (menu && opener === $('thread-conversation')) return closeMenus();
    if (moving()) return;
    open(conversationMenu(), $('thread-conversation'));
    // The search; in the Pellicule (no search), the line chosen.
    (
      menu.querySelector('input') ??
      menu.querySelector('.thread-line.is-current .thread-choice') ??
      menu.querySelector('.thread-choice')
    )?.focus();
  };
  // A right click on the project: rename it or delete it at once, a shortcut of its menu.
  $('thread-project').oncontextmenu = event => {
    event.preventDefault();
    const project = shownProject();
    if (moving() || !project || project.id === 'inbox') return;
    const list = node('div', 'thread-menu is-small');
    list.setAttribute('role', 'dialog');
    list.setAttribute('aria-label', 'Actions du projet ' + project.name);
    list.append(action('Renommer', 'edit', () => edit(project)), action('Supprimer le projet', 'trash', () => remove(project), busy));
    list.lastChild.classList.add('is-danger');
    // Greyed during a work (0.6.81), the reason under the pointer.
    if (list.lastChild.disabled) list.lastChild.dataset.tip = HELD;
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
      // The one shown is left out, unless the welcome is what shows of it (0.6.103).
      recent = (state.saveHistory ? state.historyItems || [] : [])
        .filter(item => (item.projectId || 'inbox') === project && (item.id !== state.conversationId || !$('welcome').hidden))
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
        open.disabled = !!moving();
        return open;
      }),
    );
    $('resume-last').onclick = () => recent[0] && openConversation(recent[0].id);
    $('resume-last').disabled = !!moving() || !recent.length;
    $('resume').hidden = !recent.length;
  }
  /** `keep`: a menu open stays open (a save during a work, while the user goes about, 0.6.81). */
  function render({ keep = false } = {}) {
    if (!keep) closeMenus();
    renderResume();
    const shown = shelf(),
      project = shownProject(),
      // Every project in the Pellicule: one link, « Tous les projets ».
      name = project ? projectLabel(project) : 'Tous les projets';
    $('thread-project-name').textContent = name;
    $('thread-project').setAttribute('aria-label', 'Projet : ' + name);
    // In the Pellicule, the conversation shown or all of them; the title of the one open is kept.
    const talk = shown?.filter().conversation,
      talkName =
        talk && talk !== 'all'
          ? ((state.historyItems || []).find(item => item.id === talk)?.title ?? 'Conversation')
          : 'Toutes les conversations';
    $('conversation-title').hidden = !!shown;
    $('thread-shown').hidden = !shown;
    $('thread-shown').textContent = shown ? talkName : '';
    $('thread').dataset.scope = shown ? (project ? 'project' : 'all') : '';
    $('thread-conversation').setAttribute(
      'aria-label',
      'Conversation : ' + (shown ? talkName : $('conversation-title').textContent),
    );
    $('chat-open')?.setAttribute('aria-current', state.view === 'chat' ? 'page' : 'false');
    $('studio-open').setAttribute('aria-current', state.view === 'studio' ? 'page' : 'false');
    $('bobine-open')?.setAttribute('aria-current', state.view === 'bobine' ? 'page' : 'false');
    $('library-open')?.setAttribute('aria-current', state.view === 'library' ? 'page' : 'false');
    $('studio-view').hidden = state.view !== 'studio';
    if ($('bobine-view')) $('bobine-view').hidden = state.view !== 'bobine';
    // The fil, the same in the Chat, the Studio and the Pellicule: there, it heads the sheet.
    // (0.6.148) In the Bobine, the project heads its page: « test / Le renard en hiver ».
    const bobine = state.view === 'bobine';
    if (bobine) $('thread').dataset.scope = 'bobine';
    $('thread').hidden = !['chat', 'studio', 'bobine'].includes(state.view || 'chat') && !shown;
    settle(shown ? 'library-thread' : bobine ? 'bobine-thread' : null);
    document.body.dataset.view = state.view || 'chat';
    sync();
  }
  /**
   * The fil in the head of the Archives (`#library-thread`) or of the Bobine (`#bobine-thread`), or back
   * above the Chat and the Studio (`where`: null).
   */
  function settle(where) {
    const thread = $('thread'),
      slot = where ? $(where) : null;
    if (!thread.parentNode || (where && !slot)) return;
    home ??= { parent: thread.parentNode, next: thread.nextSibling };
    if (slot && thread.parentNode !== slot) slot.append(thread);
    else if (!slot && thread.parentNode !== home.parent) home.parent.insertBefore(thread, home.next);
  }
  function sync() {
    // Never held by a work (0.6.81); for the 2 to 3 s Moodix AI sets the Studio, the reason is said.
    const held = moving(),
      setting = Boolean(state.studio?.settingUp?.());
    for (const control of document.querySelectorAll('#thread button,#chat-open,#studio-open,#bobine-open,#library-open')) {
      control.disabled = !!held;
      if (!control.dataset) continue;
      if (setting) control.dataset.heldTip ??= control.dataset.tip ?? '';
      if (setting) control.dataset.tip = 'Moodix AI règle le Studio…';
      else if (control.dataset.heldTip !== undefined) {
        if (control.dataset.heldTip) control.dataset.tip = control.dataset.heldTip;
        else delete control.dataset.tip;
        delete control.dataset.heldTip;
      }
    }
  }
  async function refresh() {
    const result = await (await api('projects')).json();
    state.projects = result.projects;
    render();
  }
  /** The Pellicule (library.mjs): its `filter`, `count` and `choose`, read by the fil while it is shown. */
  function useLibrary(shown) {
    library = shown;
  }
  return { render, refresh, sync, closeMenus, edit, remove, renderResume, useLibrary };
}
