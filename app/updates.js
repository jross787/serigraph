// Local-install maintenance. Opening an export never checks the network.
import { state, bus } from './state.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { getCamera, setCamera } from './canvas.js';

const HOUR = 60 * 60 * 1000;
const VIEW_KEY = 'serigraph-update-view';
let latest = null;
let checking = false;
let panel = null;
const draftControls = new Set();

export function updateBlocker(snapshot, hasDraft = false) {
  if (snapshot.saveStatus === 'saving') return 'Wait for the current save to finish.';
  if (snapshot.saveStatus === 'error' || snapshot.errors?.length) return 'Resolve map errors or save conflicts before updating.';
  if (snapshot.workbench) return 'Disconnect Share & sync before updating, then reconnect afterward.';
  if (hasDraft) return 'Finish draft forms and close the inspector or open dialog before updating.';
  return '';
}

export function maintenanceBlocker(exclude = panel) {
  for (const control of draftControls) if (!control.isConnected) draftControls.delete(control);
  const draft = document.querySelector('#detail.editing:not([hidden]), .decision-outcomes[data-dirty="true"]')
    || [...document.querySelectorAll('#dialog-root .dialog')].some(dialog => dialog !== exclude)
    || draftControls.size
    || [...document.querySelectorAll('#chat-dock textarea')].some(el => el.value.trim());
  return updateBlocker(state, !!draft);
}

function paintIndicator() {
  const button = document.getElementById('btn-update-available');
  if (!button) return;
  button.hidden = !latest?.enabled || latest.status !== 'available';
  button.title = latest?.target ? `Serigraph ${latest.target.slice(0, 8)} is available. Review before installing.` : 'Review the available Serigraph update';
}

async function check(force = false) {
  if (checking || state.updateApplying) return;
  checking = true;
  renderPanel();
  try {
    latest = await api.updateStatus(AbortSignal.timeout(5000));
    if (latest.enabled && (force || !latest.checkedAt || Date.now() - latest.checkedAt >= HOUR)) {
      latest = await api.updateAction('check', latest.token);
    }
  } catch (error) {
    latest = { ...latest, status: 'error', message: `Could not check for updates. ${error.message}` };
  } finally {
    checking = false;
    paintIndicator();
    renderPanel();
  }
}

function renderPanel() {
  if (!panel || state.updateApplying) return;
  const status = panel.querySelector('[data-update-status]');
  status.textContent = checking ? 'Checking for updates…'
    : latest?.status === 'available' ? 'Update available'
      : latest?.status === 'current' ? 'You’re up to date'
        : latest?.message || 'Check for a newer version of Serigraph.';
  panel.querySelector('[data-update-version]').textContent = [
    `Running: ${latest?.running?.slice(0, 8) || 'unknown'}`,
    latest?.target ? `Available: ${latest.target.slice(0, 8)} · ${latest.remote}/${latest.branch}` : '',
    latest?.checkedAt ? `Last checked: ${new Date(latest.checkedAt).toLocaleString()}` : '',
  ].filter(Boolean).join('\n');
  panel.querySelector('[data-update-blocker]').textContent = maintenanceBlocker();
  panel.querySelector('[data-update-check]').disabled = checking || latest?.enabled === false;
  panel.querySelector('[data-update-apply]').disabled = checking || latest?.status !== 'available' || !!maintenanceBlocker();
}

async function install() {
  if (state.updateApplying || checking || latest?.status !== 'available') return;
  const blocker = maintenanceBlocker();
  if (blocker) { toast(blocker, true); renderPanel(); return; }
  const approved = latest;
  state.updateApplying = true;
  panel.querySelectorAll('button').forEach(button => { button.disabled = true; });
  const status = panel.querySelector('[data-update-status]');
  status.textContent = 'Updating Serigraph… Keep this tab open.';
  try {
    try {
      await api.updateAction('apply', approved.token, { current: approved.current, target: approved.target });
    } catch (error) {
      // A lost response is not evidence that apply failed. Observe the new
      // instance instead of issuing a second mutation.
      if (error.status) throw error;
    }
    status.textContent = 'Waiting for Serigraph to restart…';
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const result = await api.updateStatus(AbortSignal.timeout(2500));
        if (result.instance !== approved.instance && result.running === approved.target) {
          // Keep the exact camera even when the hash selects a node (which
          // normally fits that node on reload). Store only view metadata.
          try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({
            library: state.libraryId, hash: location.hash, camera: getCamera(), at: Date.now(),
          })); } catch { /* existing hash/camera persistence still applies */ }
          location.reload();
          return;
        }
      } catch { /* briefly offline during a normal restart */ }
    }
    throw new Error('Restart was not confirmed. Keep this tab open, check the server on this machine, then reload when it is running. The update was not retried.');
  } catch (error) {
    state.updateApplying = false;
    latest = { ...latest, status: 'error', message: error.message };
    panel.querySelector('[data-update-close]').disabled = false;
    paintIndicator();
    renderPanel();
  }
}

function openPanel() {
  if (state.standalone || panel) return;
  if (document.querySelector('#dialog-root .dialog')) { toast('Finish the open dialog first.'); return; }
  panel = document.createElement('dialog');
  document.querySelectorAll('.utility-menu[open]').forEach(menu => { menu.open = false; });
  panel.className = 'dialog update-dialog';
  panel.setAttribute('aria-labelledby', 'update-title');
  // Static markup only; versions and server messages always use textContent.
  panel.innerHTML = `<h2 id="update-title">App updates</h2>
    <p data-update-status role="status" aria-live="polite"></p>
    <p class="update-version" data-update-version></p>
    <p class="hint">Checks run on opening the app and hourly while it is visible. They contact the configured Git remote, not your mapped systems. Nothing installs automatically.</p>
    <p class="hint">Update &amp; restart installs the revision shown above, briefly restarts this local server, and reloads this tab. Finish drafts, sync, and AI/agent work; close other Serigraph tabs first. Local map files and configuration are protected. No automatic rollback.</p>
    <p class="dialog-error" data-update-blocker></p>
    <div class="dialog-actions">
      <button type="button" class="d-btn" data-update-close>Close</button>
      <button type="button" class="d-btn" data-update-check>Check now</button>
      <button type="button" class="d-btn primary" data-update-apply>Update &amp; restart</button>
    </div>`;
  panel.querySelector('[data-update-close]').addEventListener('click', () => panel.close());
  panel.querySelector('[data-update-check]').addEventListener('click', () => check(true));
  panel.querySelector('[data-update-apply]').addEventListener('click', install);
  panel.addEventListener('cancel', event => { if (state.updateApplying) event.preventDefault(); });
  panel.addEventListener('close', () => { panel.remove(); panel = null; });
  document.getElementById('dialog-root').append(panel);
  panel.showModal();
  renderPanel();
  check();
}

export function initUpdates() {
  if (state.standalone) {
    document.getElementById('btn-updates').hidden = true;
    document.getElementById('btn-update-available').hidden = true;
    return;
  }
  document.getElementById('btn-updates').addEventListener('click', openPanel);
  document.getElementById('btn-update-available').addEventListener('click', openPanel);
  // Track actual edits, not merely the presence of controls in a collapsed
  // inspector. Applied edits rerender those controls; untouched readers can
  // update without closing their selection. Explicit draft forms also have
  // their own guards above.
  const noteDraft = event => {
    if (event.target.matches('input, textarea, select') && event.target.closest('#detail, #product-workspace')) draftControls.add(event.target);
  };
  document.addEventListener('input', noteDraft);
  document.addEventListener('change', noteDraft);
  for (const event of ['save-status', 'workbench-changed', 'view-changed']) bus.on(event, renderPanel);
  try {
    const view = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null');
    sessionStorage.removeItem(VIEW_KEY);
    if (view?.library === state.libraryId && view.hash === location.hash && Date.now() - view.at < 120_000) setCamera(view.camera);
  } catch { /* optional view restoration */ }
  // Global editing shortcuts must not act behind the native modal.
  document.addEventListener('keydown', event => {
    if (panel?.open && event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation();
  }, true);
  check();
  setInterval(() => { if (document.visibilityState === 'visible') check(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}
