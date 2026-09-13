// A reviewed handoff to GitHub's native issue editor. Photo bytes stay local
// until the user pastes/attaches them there; no token or private map auto-upload.
import { api } from './api.js';
import { state } from './state.js';
import { toast } from './ui.js';

const ISSUE_URL = 'https://github.com/jross787/serigraph/issues/new';
export function bugReportDraft({ title, happened, steps, expected, diagnostics = '', photos = 0 }) {
  const body = [
    '### What happened', happened.trim(), '### Steps to reproduce', steps.trim(),
    '### Expected behavior', expected.trim(),
    diagnostics ? '### App details\n' + diagnostics : '',
    photos ? `### Photos\nAttach the ${photos} reviewed photo${photos === 1 ? '' : 's'} here before submitting.` : '',
  ].filter(Boolean).join('\n\n');
  const url = new URL(ISSUE_URL);
  url.searchParams.set('title', title.trim());
  url.searchParams.set('body', body);
  return { title: title.trim(), body, url: url.href };
}

export function bugReportDialog() {
  if (document.querySelector('#dialog-root .dialog')) { toast('Finish the open dialog first.'); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog bug-report-dialog';
  dialog.setAttribute('aria-labelledby', 'bug-report-title');
  dialog.innerHTML = `<h2 id="bug-report-title">Report a bug</h2>
    <p class="hint">Help us see what you see. This opens a draft in <strong>jross787/serigraph</strong> on GitHub. Issues and attached photos will be public.</p>
    <form class="bug-report-form">
      <label>Short title<input name="title" class="f-input" required maxlength="120" placeholder="For example: a decision label overlaps its shape"></label>
      <label>What happened?<textarea name="happened" class="f-textarea" required maxlength="1600"></textarea></label>
      <label>Steps to reproduce<textarea name="steps" class="f-textarea" maxlength="1200" placeholder="1. Open a map…"></textarea></label>
      <label>What did you expect?<textarea name="expected" class="f-textarea" maxlength="800"></textarea></label>
      <label class="bug-photo-picker">Photos<input name="photos" type="file" accept="image/png,image/jpeg,image/webp" multiple></label>
      <p class="hint">Up to 6 photos, 8 MB each. Preview here; copy each photo and paste it into the GitHub draft, or attach its downloaded copy there. Choosing photos does not upload them.</p>
      <div class="bug-photos"></div>
      <label class="bug-check"><input name="diagnostics" type="checkbox" checked>Include app revision, theme, and viewport size</label>
      <details class="bug-preview"><summary>Preview report text</summary><pre></pre></details>
      <label class="bug-check"><input name="reviewed" type="checkbox" required>I reviewed the text and photos. They contain no patient, customer, credential, or other private information.</label>
      <p class="dialog-error" role="status"></p>
      <a class="bug-draft-link" target="_blank" rel="noopener noreferrer" hidden>Continue to the reviewed GitHub draft ↗</a>
      <div class="dialog-actions"><button type="button" class="d-btn" data-close>Cancel</button><button type="submit" class="d-btn primary">Open GitHub draft</button></div>
    </form>`;
  const form = dialog.querySelector('form');
  const error = dialog.querySelector('[role="status"]');
  const draftLink = dialog.querySelector('.bug-draft-link');
  let revision = 'unavailable';
  let photos = [];
  let processing = false;
  const draft = () => bugReportDraft({
    title: form.elements.title.value, happened: form.elements.happened.value,
    steps: form.elements.steps.value, expected: form.elements.expected.value,
    diagnostics: form.elements.diagnostics.checked ? `Revision: ${revision}\nTheme: ${document.documentElement.dataset.theme}\nViewport: ${window.innerWidth} × ${window.innerHeight}\nMode: ${state.standalone ? 'standalone export' : 'local app'}` : '',
    photos: photos.length,
  });
  const preview = () => { dialog.querySelector('pre').textContent = draft().body; };
  form.addEventListener('input', event => {
    if (event.target.name !== 'reviewed') form.elements.reviewed.checked = false;
    draftLink.hidden = true;
    preview();
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { photos.forEach(photo => URL.revokeObjectURL(photo.url)); dialog.remove(); });
  form.elements.photos.addEventListener('change', async () => {
    if (processing) return;
    const files = [...form.elements.photos.files];
    form.elements.photos.value = '';
    if (files.length + photos.length > 6 || files.some(file => file.size > 8 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
      error.textContent = 'Use at most 6 PNG, JPEG, or WebP photos, each no larger than 8 MB.';
      return;
    }
    processing = true;
    form.querySelector('[type="submit"]').disabled = true;
    try {
      for (const file of files) {
        const image = await createImageBitmap(file);
        const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close();
        // PNG re-encoding strips camera metadata and provides a clipboard
        // format supported by the issue editor. Never send the original file.
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob || !dialog.isConnected) continue;
        const photo = { blob, url: URL.createObjectURL(blob) };
        photos.push(photo);
        const figure = document.createElement('figure');
        const img = document.createElement('img'); img.src = photo.url; img.alt = `Bug report photo ${photos.length}`;
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'd-btn'; copy.textContent = 'Copy photo';
        copy.onclick = async () => {
          try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); error.textContent = ''; toast('Photo copied. Paste it into the GitHub issue editor.'); }
          catch { error.textContent = 'This browser cannot copy images. Download the photo, then attach it on GitHub.'; }
        };
        const download = document.createElement('a'); download.href = photo.url; download.download = `bug-photo-${photos.length}.png`; download.textContent = 'Download photo';
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'bug-photo-remove'; remove.textContent = 'Remove';
        remove.onclick = () => { photos = photos.filter(item => item !== photo); URL.revokeObjectURL(photo.url); figure.remove(); preview(); form.elements.reviewed.checked = false; };
        figure.append(img, copy, download, remove); dialog.querySelector('.bug-photos').append(figure);
      }
      form.elements.reviewed.checked = false;
      error.textContent = '';
      preview();
    } catch { error.textContent = 'A photo could not be decoded. Try a PNG or JPEG screenshot.'; }
    finally { processing = false; form.querySelector('[type="submit"]').disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (processing || !form.reportValidity()) return;
    const report = draft();
    if (!report.title || !form.elements.happened.value.trim()) {
      error.textContent = 'Add a title and a description of what happened.';
      return;
    }
    if (report.url.length > 7500) {
      try { await navigator.clipboard.writeText(report.body); }
      catch { error.textContent = 'This report is too long for a draft link. Copy the preview text, shorten the report, or paste it into a new GitHub issue.'; return; }
      const url = new URL(ISSUE_URL); url.searchParams.set('title', report.title); report.url = url.href;
      error.textContent = 'Report text copied. Paste it into the GitHub draft, then add the photos.';
    } else error.textContent = 'Continue in GitHub: attach the reviewed photos and select Submit new issue there. No issue has been published by Serigraph.';
    // Always leave a real link, including when a browser blocks the popup
    // after the asynchronous clipboard fallback for long reports.
    draftLink.href = report.url;
    draftLink.hidden = false;
    window.open(report.url, '_blank', 'noopener,noreferrer');
  });
  document.getElementById('dialog-root').append(dialog);
  dialog.showModal();
  preview();
  if (!state.standalone) api.updateStatus(AbortSignal.timeout(3000)).then(status => {
    revision = status.running?.slice(0, 12) || 'unavailable'; preview();
  }).catch(() => {});
}
