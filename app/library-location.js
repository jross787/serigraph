import { api } from './api.js';
import { state } from './state.js';
import { maintenanceBlocker } from './updates.js';
import { toast } from './ui.js';

export async function libraryLocationDialog() {
  if (state.standalone) return;
  if (document.querySelector('#dialog-root .dialog')) { toast('Finish the open dialog first.'); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog library-dialog';
  dialog.setAttribute('aria-labelledby', 'library-title');
  dialog.innerHTML = `<h2 id="library-title">Project files</h2>
    <p class="hint">Choose the folder that contains your <code>maps/</code> and <code>projects/</code> folders. The app stays installed where it is.</p>
    <p class="update-version" data-current></p>
    <form class="bug-report-form">
      <label>Folder path<input name="path" class="f-input" required autocomplete="off" spellcheck="false" placeholder="Absolute path to an existing folder"></label>
      <p class="hint">Create the folder in Finder or File Explorer first, then paste its full path here. Existing files stay where they are. This does not move or copy maps, projects, trash, or credentials.</p>
      <button type="submit" class="d-btn" data-preview>Preview folder</button>
    </form>
    <p class="update-version" data-summary></p>
    <label class="bug-check"><input type="checkbox" data-trust> I trust this folder and its .env settings, which will be loaded when Serigraph restarts.</label>
    <p class="hint">Close other tabs and finish drafts, sync, and AI/agent work first. Switching opens Projects in the selected folder. The choice is saved on this machine for this installation.</p>
    <p class="dialog-error" data-status role="status"></p>
    <div class="dialog-actions"><button class="d-btn" data-close>Cancel</button><button class="d-btn primary" data-switch disabled>Use folder &amp; restart</button></div>`;
  const form = dialog.querySelector('form'), input = form.elements.path;
  const status = dialog.querySelector('[data-status]');
  const trust = dialog.querySelector('[data-trust]');
  const apply = dialog.querySelector('[data-switch]');
  let current, preview, busy = false;
  const blocker = () => maintenanceBlocker(dialog).replaceAll('updating', 'switching folders');
  const paint = () => { apply.disabled = busy || !preview || !trust.checked || !!blocker() || preview.path === current?.path; };
  const invalidate = () => { preview = null; trust.checked = false; dialog.querySelector('[data-summary]').textContent = ''; paint(); };
  input.addEventListener('input', invalidate);
  trust.addEventListener('change', paint);
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (state.updateApplying) event.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !current?.enabled || !form.reportValidity()) return;
    invalidate(); busy = true; input.disabled = true; paint();
    status.textContent = 'Checking folder…';
    try {
      preview = await api.libraryAction('preview', current.token, { path: input.value.trim() });
      dialog.querySelector('[data-summary]').textContent = `${preview.path}\n${preview.maps} ungrouped maps · ${preview.projects} project folders\n${preview.hasEnv ? '.env present — only continue if you trust its settings.' : 'No .env found. No credentials will be copied.'}`;
      status.textContent = preview.path === current.path ? 'This folder is already active.' : blocker();
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; input.disabled = false; paint(); }
  });
  apply.addEventListener('click', async () => {
    if (busy || !preview || !trust.checked) return;
    if (blocker()) { status.textContent = blocker(); paint(); return; }
    busy = true; state.updateApplying = true;
    dialog.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
    status.textContent = 'Switching folders and restarting…';
    try {
      try { await api.libraryAction('switch', current.token, { nonce: preview.nonce, trusted: true }); }
      catch (error) { if (error.status) throw error; /* uncertain response: observe, never retry */ }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          // Only this explicitly approved handoff can read a new identity.
          // Ordinary APIs remain pinned to the old library and fail closed.
          const response = await fetch('/api/library', { signal: AbortSignal.timeout(2500), cache: 'no-store' });
          if (!response.ok) continue;
          const next = await response.json();
          if (next.path === preview.path && next.libraryId !== current.libraryId) {
            location.replace(location.pathname + location.search + '#/');
            location.reload();
            return;
          }
        } catch { /* server briefly offline */ }
      }
      throw new Error('Restart was not confirmed. Check this machine’s server, then reload. The folder switch was not retried.');
    } catch (error) {
      busy = false; state.updateApplying = false;
      invalidate(); status.textContent = error.message;
      dialog.querySelectorAll('button, input').forEach(el => { el.disabled = false; });
      paint();
    }
  });
  document.getElementById('dialog-root').append(dialog); dialog.showModal();
  input.disabled = true;
  try {
    current = await api.libraryStatus(AbortSignal.timeout(5000));
    dialog.querySelector('[data-current]').textContent = current.path ? `Current folder\n${current.path}` : '';
    input.value = current.path || '';
    input.disabled = !current.enabled;
    dialog.querySelector('[data-preview]').disabled = !current.enabled;
    trust.disabled = !current.enabled;
    status.textContent = current.message || blocker();
  } catch (error) { status.textContent = error.message; }
}
