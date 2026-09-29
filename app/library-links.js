import { api } from './api.js';
import { state } from './state.js';
import * as ctrl from './controller.js';
import { toast, newMapDialog, openSearch } from './ui.js';
import { maintenanceBlocker } from './updates.js';
import { icon } from './icons.js';

// The Mac app hosts this page in a native window and answers File → Open,
// Finder "Open With", and files dropped on its Dock icon with a real path.
const nativeHost = () => window.webkit?.messageHandlers?.serigraph ?? null;
export const isNativeMac = () => !!nativeHost();

// Open a YAML map file or map folder where it already lives. The file stays
// in place; edits save to it, and it joins Recent Files on every machine
// that shares this library.
export async function openLocalPath(path) {
  if (state.standalone || state.updateApplying) return;
  if (state.mapId && maintenanceBlocker()) { toast('Finish or discard the open edit before opening another file.', true); return; }
  let result;
  try {
    const status = await api.localLinksStatus();
    if (!status.enabled) { toast(status.message || 'Opening local files is not available here.', true); return; }
    result = await api.localLinksAction('open', status.token, { path });
  } catch (error) {
    toast(`Couldn't open that file: ${error.message}`, true);
    return;
  }
  await Promise.all([ctrl.loadMapList(), ctrl.loadProjects(), ctrl.loadRecents()]).catch(() => {});
  if (result.mapId) await ctrl.openMap(result.mapId);
  else {
    ctrl.goHome();
    toast(`Opened the folder “${result.name ?? 'folder'}”. Its maps are listed under Projects.`);
  }
}

// File → Open…: the Mac file picker in the native app, a path field otherwise.
export function openFile() {
  if (state.standalone) return;
  const host = nativeHost();
  if (host) host.postMessage({ type: 'open-panel' });
  else localLibraryDialog();
}

export function initNativeBridge() {
  if (state.standalone) return;
  window.serigraph = Object.freeze({
    openPath: openLocalPath,
    openFile,
    newMap: () => newMapDialog(),
    goHome: () => ctrl.goHome(),
    search: () => openSearch(),
    checkForUpdates: () => document.getElementById('btn-updates')?.click(),
  });
  const host = nativeHost();
  if (!host) return;
  document.documentElement.classList.add('native-mac');
  reportTitleBar(host);
  host.postMessage({ type: 'ready' });
}

// In the Mac app the top bar is also the window's title bar. Tell the app
// where the bar's controls are, so a press anywhere else moves the window.
// While a dialog covers the page, the bar is not draggable.
function reportTitleBar(host) {
  const bar = document.getElementById('topbar');
  if (!bar) return;
  let frame = 0;
  const report = () => {
    frame = 0;
    const covered = document.querySelector('dialog[open], .dialog-backdrop, #search-overlay:not([hidden])');
    const controls = covered ? [] : [...bar.querySelectorAll('button, a, input, select, [role="button"], [tabindex]:not([tabindex="-1"])')]
      .map((control) => control.getBoundingClientRect())
      .filter((rect) => rect.width && rect.height)
      .map((rect) => ({ x: rect.x - 3, y: rect.y - 3, width: rect.width + 6, height: rect.height + 6 }));
    host.postMessage({ type: 'titlebar', height: covered ? 0 : bar.getBoundingClientRect().bottom, controls });
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(report); };
  new ResizeObserver(schedule).observe(bar);
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] });
  window.addEventListener('resize', schedule);
  report();
}

const FOLDER_KEY = 'serigraph-open-folder';
const PLACE_ICONS = { home: 'house', desktop: 'desktop', folder: 'folder', downloads: 'download-simple', code: 'terminal-window', cloud: 'cloud' };

// A small Finder-like browser for the Open dialog: places on the left, one
// folder's subfolders and YAML files on the right. Clicking a folder goes into
// it; clicking a file chooses it, and clicking it again opens it.
function fileBrowser(root, { token, onPick, onOpen, onError }) {
  const places = root.querySelector('.fb-places'), list = root.querySelector('.fb-list');
  const title = root.querySelector('.fb-name'), up = root.querySelector('.fb-up');
  let listing = null, chosen = null;
  const row = (className, iconName, label, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    const text = document.createElement('span');
    text.textContent = label;
    button.append(icon(iconName, 16), text);
    button.addEventListener('click', onClick);
    return button;
  };
  const paint = () => {
    title.textContent = listing.name;
    title.title = listing.path;
    up.disabled = !listing.parent;
    places.replaceChildren(...listing.places.map((place) => {
      const button = row('fb-place', PLACE_ICONS[place.icon] ?? 'folder', place.name, () => go(place.path));
      if (place.path === listing.path) button.setAttribute('aria-current', 'true');
      button.title = place.path;
      return button;
    }));
    const items = [
      ...listing.folders.map((folder) => row('fb-item fb-folder', 'folder', folder.name, () => go(folder.path))),
      ...listing.files.map((file) => {
        const button = row('fb-item fb-file', 'file-text', file.name, () => {
          if (chosen === file.path) { onOpen(file.path); return; }
          chosen = file.path;
          for (const other of list.querySelectorAll('[aria-selected="true"]')) other.setAttribute('aria-selected', 'false');
          button.setAttribute('aria-selected', 'true');
          onPick(file.path, true);
        });
        button.setAttribute('aria-selected', 'false');
        button.addEventListener('dblclick', () => onOpen(file.path));
        return button;
      }),
    ];
    const note = !items.length ? 'This folder has no subfolders or YAML files.'
      : listing.more ? 'This folder is very large, so only part of it is listed.' : '';
    if (note) {
      const hint = document.createElement('p');
      hint.className = 'fb-note';
      hint.textContent = note;
      items.push(hint);
    }
    list.replaceChildren(...items);
    list.scrollTop = 0;
  };
  async function go(target) {
    let next;
    try { next = await api.localLinksAction('browse', token, { path: target }); }
    catch (error) { onError(error.message); return false; }
    listing = next; chosen = null;
    try { localStorage.setItem(FOLDER_KEY, next.path); } catch { /* a per-viewer convenience */ }
    paint();
    onPick(next.path, next.files.length > 0);
    return true;
  }
  up.addEventListener('click', () => { if (listing?.parent) go(listing.parent); });
  return {
    async start() {
      let last = null;
      try { last = localStorage.getItem(FOLDER_KEY); } catch { /* start at home */ }
      root.hidden = false;
      if (!last || !(await go(last))) await go('~');
    },
  };
}

export async function localLibraryDialog(removing = null) {
  if (state.standalone || state.updateApplying) return;
  if (document.querySelector('#dialog-root .dialog')) { toast('Finish the open dialog first.'); return; }
  const returnFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog library-dialog local-links-dialog';
  dialog.setAttribute('aria-labelledby', 'local-links-title');
  dialog.innerHTML = `<h2 id="local-links-title">${removing ? 'Remove link' : 'Open a map file'}</h2>
    <p class="hint">${removing ? 'Serigraph forgets this location on every Mac that shares your library. The original files are not deleted or moved.'
      : 'Choose a YAML map file, or a folder of them, anywhere on this Mac. It stays where it is, and your edits save to it.'}</p>
    <div class="file-browser" hidden>
      <nav class="fb-places" aria-label="Places"></nav>
      <div class="fb-main">
        <div class="fb-bar"><button type="button" class="fb-up d-btn" aria-label="Enclosing folder" title="Enclosing folder"></button><strong class="fb-name"></strong></div>
        <div class="fb-list" role="group" aria-label="Folders and map files"></div>
      </div>
    </div>
    <form class="bug-report-form" ${removing ? 'hidden' : ''}>
      <label>File or folder path<input name="path" class="f-input" required autocomplete="off" spellcheck="false" placeholder="~/Code/my-repo/process.yaml"></label>
      <p class="hint" data-hint>A folder opens the maps directly inside it, not the maps in its subfolders.</p>
    </form>
    <p class="update-version" data-location></p>
    <p class="dialog-error" data-status role="status" aria-live="polite"></p>
    <div class="dialog-actions"><button class="d-btn" data-close>Cancel</button><button class="d-btn primary" data-apply disabled>${removing ? 'Remove link' : 'Open'}</button></div>`;
  const query = selector => dialog.querySelector(selector);
  const form = query('form'), input = form.elements.path;
  const status = query('[data-status]'), apply = query('[data-apply]');
  query('.fb-up').append(icon('arrow-left', 16));
  let current, busy = false, emptyFolder = null;
  const paint = () => {
    apply.disabled = busy || !current?.enabled || (!removing && (!input.value.trim() || input.value === emptyFolder));
    input.disabled = busy || !current?.enabled;
    query('[data-close]').disabled = busy;
  };
  input.addEventListener('input', () => { status.textContent = ''; paint(); });
  query('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (returnFocus?.isConnected) returnFocus.focus(); });
  const submit = async () => {
    if (busy || !current?.enabled) return;
    if (removing) {
      if (state.mapId?.startsWith(`${removing.slug}/`)) {
        const blocker = maintenanceBlocker(dialog);
        if (blocker) { status.textContent = blocker.replaceAll('updating', 'removing this link'); return; }
      }
      busy = true; paint(); status.textContent = 'Removing the link…';
      try { await api.localLinksAction('remove', current.token, { id: removing.slug }); }
      catch (error) { status.textContent = error.status ? error.message : 'The response was interrupted. Check Projects before trying again.'; busy = false; paint(); return; }
      dialog.close();
      if (state.mapId?.startsWith(`${removing.slug}/`)) ctrl.goHome();
      try { await Promise.all([ctrl.loadProjects(), ctrl.loadMapList()]); }
      catch { toast('The link was removed. Reload Projects to refresh the list.', true); return; }
      toast('Link removed. The original files are untouched.');
      return;
    }
    if (!form.reportValidity() || apply.disabled) return;
    busy = true; paint(); status.textContent = 'Opening…';
    try {
      await api.localLinksAction('preview', current.token, { path: input.value.trim() });
    } catch (error) { status.textContent = error.message; busy = false; paint(); return; }
    dialog.close();
    await openLocalPath(input.value.trim());
  };
  form.addEventListener('submit', event => { event.preventDefault(); submit(); });
  apply.onclick = submit;
  document.getElementById('dialog-root').append(dialog); dialog.showModal();
  if (removing) query('[data-location]').textContent = removing.location;
  try { current = await api.localLinksStatus(); status.textContent = current.message || ''; }
  catch (error) { status.textContent = error.message; }
  paint();
  if (removing) return;
  input.focus();
  if (!current?.enabled) return;
  // The path field always shows what Open will open: the folder on screen, or
  // the file chosen in it. A folder without maps cannot be opened.
  await fileBrowser(query('.file-browser'), {
    token: current.token,
    onPick: (path, hasMaps) => {
      input.value = path; emptyFolder = hasMaps ? null : path; status.textContent = '';
      query('[data-hint]').textContent = hasMaps ? 'A folder opens the maps directly inside it, not the maps in its subfolders.'
        : 'This folder has no maps directly inside it. Open one of its folders, or choose a YAML file.';
      paint();
    },
    onOpen: (path) => { input.value = path; emptyFolder = null; paint(); submit(); },
    onError: (message) => { status.textContent = message; },
  }).start();
}
