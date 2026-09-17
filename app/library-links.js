import { api } from './api.js';
import { state } from './state.js';
import * as ctrl from './controller.js';
import { toast } from './ui.js';
import { maintenanceBlocker } from './updates.js';

export async function localLibraryDialog(removing = null) {
  if (state.standalone || state.updateApplying) return;
  if (document.querySelector('#dialog-root .dialog')) { toast('Finish the open dialog first.'); return; }
  const returnFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog library-dialog local-links-dialog';
  dialog.setAttribute('aria-labelledby', 'local-links-title');
  dialog.innerHTML = `<h2 id="local-links-title">${removing ? 'Remove library link' : 'Add to library'}</h2>
    <p class="hint">${removing ? 'Only the saved reference will be removed. The original files will not be deleted or moved.'
      : 'Link a local YAML file or map folder where it already lives. Nothing is copied into Serigraph’s repository. Edits save directly to the originals.'}</p>
    <form class="bug-report-form" ${removing ? 'hidden' : ''}>
      <label>File or folder path<input name="path" class="f-input" required autocomplete="off" spellcheck="false" placeholder="Absolute path to a YAML file or map folder"></label>
      <p class="hint">Paste the full path from Finder or File Explorer. A folder includes its immediate YAML files and optional projects.yaml index—not subfolders, hidden files, .env, or credentials.</p>
      <button type="submit" class="d-btn" data-preview disabled>Preview location</button>
    </form>
    <p class="update-version" data-location></p>
    <section data-results hidden aria-label="Location preview"><h3 data-summary></h3><ul class="local-links-list" data-list></ul></section>
    <label class="bug-check" ${removing ? 'hidden' : ''}><input type="checkbox" data-trust> I understand that changes in Serigraph will edit the original files.</label>
    <p class="hint">${removing ? 'You can add this location again later.' : 'Links are remembered privately on this machine for this library. Removing a link never deletes the originals. The source folder’s own Git or cloud-sync rules still apply.'}</p>
    <p class="dialog-error" data-status role="status" aria-live="polite">Connecting to the local app…</p>
    <div class="dialog-actions"><button class="d-btn" data-close>Cancel</button><button class="d-btn primary" data-apply disabled>${removing ? 'Remove link' : 'Link location'}</button></div>`;
  const query = selector => dialog.querySelector(selector);
  const form = query('form'), input = form.elements.path, trust = query('[data-trust]');
  const status = query('[data-status]'), apply = query('[data-apply]');
  let current, preview, busy = false;
  const paint = () => {
    apply.disabled = busy || !current?.enabled || (!removing && (!preview || !trust.checked));
    input.disabled = busy || !current?.enabled;
    query('[data-preview]').disabled = busy || !current?.enabled;
    query('[data-close]').disabled = busy;
    trust.disabled = busy;
  };
  const invalidate = () => { preview = null; trust.checked = false; query('[data-results]').hidden = true; paint(); };
  input.addEventListener('input', invalidate);
  trust.addEventListener('change', paint);
  query('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (returnFocus?.isConnected) returnFocus.focus(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !current?.enabled || !form.reportValidity()) return;
    invalidate(); busy = true; paint(); status.textContent = 'Checking only the selected location…';
    try {
      preview = await api.localLinksAction('preview', current.token, { path: input.value.trim() });
      query('[data-location]').textContent = preview.path;
      query('[data-summary]').textContent = `${preview.name} · ${preview.mapCount} map${preview.mapCount === 1 ? '' : 's'}`;
      query('[data-list]').replaceChildren(...preview.maps.map(map => {
        const item = document.createElement('li');
        item.textContent = `${map.name} — ${map.invalid ? `${map.errorCount} validation problem(s)` : `${map.nodeCount} nodes`}`;
        return item;
      }));
      query('[data-results]').hidden = false;
      status.textContent = preview.indexErrors ? 'The project index has validation problems; its metadata may be incomplete.' : '';
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; paint(); }
  });
  apply.onclick = async () => {
    if (busy || !current?.enabled || (!removing && (!preview || !trust.checked))) return;
    if (removing && state.mapId?.startsWith(`${removing.slug}/`)) {
      const blocker = maintenanceBlocker(dialog);
      if (blocker) { status.textContent = blocker.replaceAll('updating', 'removing this link'); return; }
    }
    busy = true; paint(); status.textContent = removing ? 'Removing the reference…' : 'Saving the local reference…';
    try {
      await api.localLinksAction(removing ? 'remove' : 'add', current.token,
        removing ? { id: removing.slug } : { nonce: preview.nonce, editOriginals: true });
    } catch (error) {
      status.textContent = error.status ? error.message : 'The response was interrupted. Check Projects before trying again.';
      busy = false; invalidate(); return;
    }
    dialog.close();
    if (removing && state.mapId?.startsWith(`${removing.slug}/`)) ctrl.goHome();
    try { await Promise.all([ctrl.loadProjects(), ctrl.loadMapList()]); }
    catch { toast('The link was updated. Reload Projects to refresh the list.', true); return; }
    toast(removing ? 'Link removed. Original files are untouched.' : 'Location linked. Edits save to the original files.');
  };
  document.getElementById('dialog-root').append(dialog); dialog.showModal();
  if (removing) query('[data-location]').textContent = removing.location;
  try { current = await api.localLinksStatus(); status.textContent = current.message || ''; }
  catch (error) { status.textContent = error.message; }
  paint();
}
