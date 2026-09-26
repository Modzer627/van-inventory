// Settings: scanning prefs, import/export, backup/restore, deleted parts, storage, install.
import { metaGet, metaSet, dbClear, dbAll, STORES, uuid, setDeviceId } from '../db.js';
import { exportBackup, readBackupFile, restoreBackup, daysSinceBackup } from '../backup.js';
import { exportInventoryXlsx, exportInventoryCsv } from '../export.js';
import { allParts, deletedParts, restorePart, displayName } from '../items.js';
import { codesByItem } from '../barcodes.js';
import { allLocations, ensureSeed, labelOf, locationMap } from '../locations.js';
import { allTxns } from '../txns.js';
import { latestCommitted, quarterStart } from '../counts.js';
import { detectorKind } from '../scanner.js';
import { esc, toast, confirmDialog, setSoundEnabled, setHapticsEnabled, sheet, fmtDate, pluralize } from '../ui.js';
import * as nav from '../nav.js';

const section = () => document.getElementById('screen-settings');
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

async function render() {
  const sec = section();
  const [sound, haptics, confirmEach, stepEa, stepFt, startTab, backupDays, lastImport, cameraId] = await Promise.all([
    metaGet('soundOn', true), metaGet('hapticsOn', true), metaGet('confirmEachScan', false), metaGet('stepEa', 1), metaGet('stepFt', 25),
    metaGet('startTab', 'scan'), daysSinceBackup(), metaGet('lastImport', null), metaGet('cameraDeviceId', null),
  ]);
  const counts = { items: (await allParts()).length, txns: (await dbAll('txns')).length, deleted: (await deletedParts()).length };
  let storageLine = 'Storage: unknown';
  try {
    const est = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    storageLine = `Using ${((est.usage || 0) / 1048576).toFixed(1)} MB · ${persisted ? 'protected from cleanup' : 'not yet marked persistent (install the app)'}`;
  } catch { /* older browsers */ }

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>Settings</h1>
    </header>
    <div class="content">
      <div class="section-title">Scanning</div>
      <div class="set-group">
        <div class="set-row"><div class="grow">Beep on scan</div><label class="switch"><input type="checkbox" data-sound ${sound ? 'checked' : ''}><span></span></label></div>
        <div class="set-row"><div class="grow">Vibrate on scan</div><label class="switch"><input type="checkbox" data-haptics ${haptics ? 'checked' : ''}><span></span></label></div>
        <div class="set-row"><div class="grow">Confirm each scan<span class="hint">Off: Remove/Add apply instantly with an Undo card</span></div><label class="switch"><input type="checkbox" data-confirm ${confirmEach ? 'checked' : ''}><span></span></label></div>
        <div class="set-row"><div class="grow">Default step (pieces)</div><select data-stepea>${[1, 2, 5, 10].map(n => `<option value="${n}"${Number(stepEa) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="set-row"><div class="grow">Default step (feet)</div><select data-stepft>${[10, 25, 50, 100].map(n => `<option value="${n}"${Number(stepFt) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="set-row"><div class="grow">Open the app on</div><select data-starttab><option value="scan"${startTab === 'scan' ? ' selected' : ''}>Scan</option><option value="parts"${startTab === 'parts' ? ' selected' : ''}>Parts</option><option value="shelves"${startTab === 'shelves' ? ' selected' : ''}>Shelves</option></select></div>
        <div class="set-row"><div class="grow">Camera<span class="hint">Decoder: ${detectorKind() === 'native' ? 'phone (fast)' : detectorKind() === 'wasm' ? 'built-in library' : 'not started yet'}${cameraId ? ' · a rear camera is remembered' : ''}</span></div><button class="btn btn-sm" data-forgetcam ${cameraId ? '' : 'disabled'}>Forget camera</button></div>
      </div>

      <div class="section-title">Van</div>
      <div class="set-group">
        <div class="set-row tap" data-locations><div class="grow">Shelves &amp; locations<span class="hint">Rename, reorder, add drawers, merge</span></div><span>›</span></div>
      </div>

      <div class="section-title">Your data</div>
      <div class="set-group">
        <div class="set-row">
          <div class="grow">Import spreadsheet<span class="hint">.xlsx or .csv with Brand, Model, Amount, Barcode, Type, Shelf${lastImport ? `<br>Last: ${esc(lastImport.fileName || '')} · ${fmtDate(lastImport.at)} · ${lastImport.created} added` : ''}</span></div>
          <button class="btn btn-sm btn-primary" data-import>Choose file</button>
          <input type="file" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-import-file hidden>
        </div>
        <div class="set-row"><div class="grow">Excel export<span class="hint">Inventory · By shelf · Low stock · Return pile · Movements</span></div><button class="btn btn-sm" data-xlsx>Export</button></div>
        <div class="set-row"><div class="grow">CSV export<span class="hint">Inventory only — Excel drops leading zeros from CSV, prefer .xlsx</span></div><button class="btn btn-sm" data-csv>Export</button></div>
        <div class="set-row"><div class="grow">Backup<span class="hint">${backupDays === null ? 'Never backed up' : backupDays === 0 ? 'Backed up today' : `Last backup ${backupDays} day${backupDays === 1 ? '' : 's'} ago`} · ${counts.items} parts, ${counts.txns} movements</span></div><button class="btn btn-sm" data-backup>Back up</button></div>
        <div class="set-row"><div class="grow">Restore<span class="hint">Load a backup file</span></div><button class="btn btn-sm" data-restore>Choose file</button><input type="file" accept=".json,application/json" data-restore-file hidden></div>
        <div class="set-row tap" data-deleted><div class="grow">Deleted parts<span class="hint">${counts.deleted ? `${pluralize(counts.deleted, 'part')} can be restored` : 'None'}</span></div><span>›</span></div>
        <div class="set-row"><div class="grow" style="color:var(--danger)">Erase everything<span class="hint">Deletes all parts, history and settings from this phone</span></div><button class="btn btn-sm" data-wipe style="color:var(--danger)">Erase</button></div>
      </div>

      <div class="section-title">App</div>
      <div class="set-group">
        <div class="set-row"><div class="grow">${esc(storageLine)}<span class="hint">All data stays on this phone — back up regularly</span></div></div>
        <div class="set-row" data-install-row hidden><div class="grow">Install on this phone<span class="hint">Home-screen app, full screen, works offline</span></div><button class="btn btn-sm btn-primary" data-install>Install</button></div>
        <div class="set-row"><div class="grow">Version ${esc(window.__appVersion || 'dev')}<span class="hint">${window.__updateReady ? 'Update ready' : 'Up to date'}</span></div>${window.__updateReady ? '<button class="btn btn-sm btn-primary" data-apply-update>Update</button>' : ''}</div>
      </div>
      ${!isStandalone() && !window.__installPrompt ? '<div class="banner info" style="line-height:1.6">📲 To install: open Chrome’s menu (⋮) and choose <b>Add to Home screen</b> / <b>Install app</b>.</div>' : ''}
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-sound]').addEventListener('change', async (e) => { await metaSet('soundOn', e.target.checked); setSoundEnabled(e.target.checked); });
  sec.querySelector('[data-haptics]').addEventListener('change', async (e) => { await metaSet('hapticsOn', e.target.checked); setHapticsEnabled(e.target.checked); });
  sec.querySelector('[data-confirm]').addEventListener('change', (e) => metaSet('confirmEachScan', e.target.checked));
  sec.querySelector('[data-stepea]').addEventListener('change', (e) => metaSet('stepEa', Number(e.target.value)));
  sec.querySelector('[data-stepft]').addEventListener('change', (e) => metaSet('stepFt', Number(e.target.value)));
  sec.querySelector('[data-starttab]').addEventListener('change', (e) => metaSet('startTab', e.target.value));
  sec.querySelector('[data-forgetcam]').addEventListener('click', async () => { await metaSet('cameraDeviceId', null); await metaSet('cameraZoom', null); toast('Camera choice forgotten'); render(); });
  sec.querySelector('[data-locations]').addEventListener('click', () => nav.show('locations'));

  sec.querySelector('[data-xlsx]').addEventListener('click', openExportSheet);
  sec.querySelector('[data-csv]').addEventListener('click', async () => {
    const [items, codes, locations] = await Promise.all([allParts(), codesByItem(), allLocations()]);
    const r = await exportInventoryCsv({ items, codesByItem: codes, locations });
    if (r === 'shared' || r === 'downloaded') toast('CSV exported');
  });
  sec.querySelector('[data-backup]').addEventListener('click', async () => {
    const r = await exportBackup();
    if (r === 'shared' || r === 'downloaded') { toast('Backup saved'); render(); }
  });
  const restoreInput = sec.querySelector('[data-restore-file]');
  sec.querySelector('[data-restore]').addEventListener('click', () => restoreInput.click());
  restoreInput.addEventListener('change', async () => {
    const file = restoreInput.files[0];
    restoreInput.value = '';
    if (!file) return;
    try { openRestoreChoice(await readBackupFile(file)); } catch (e) { toast(e.message, { error: true }); }
  });
  const importInput = sec.querySelector('[data-import-file]');
  sec.querySelector('[data-import]').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (file) await startImport(file);
  });
  sec.querySelector('[data-deleted]').addEventListener('click', openDeletedSheet);
  sec.querySelector('[data-wipe]').addEventListener('click', async () => {
    if (!(await confirmDialog('Erase ALL parts, history, counts and settings from this phone?', { danger: true, okLabel: 'Erase' }))) return;
    if (!(await confirmDialog('Really erase everything? There is no undo unless you have a backup file.', { danger: true, okLabel: 'Erase everything' }))) return;
    await dbClear(...STORES);
    await ensureSeed();
    const dev = uuid(); await metaSet('deviceId', dev); setDeviceId(dev);
    toast('All data erased');
    nav.showTab('parts');
  });
  const installRow = sec.querySelector('[data-install-row]');
  if (window.__installPrompt && !isStandalone()) {
    installRow.hidden = false;
    sec.querySelector('[data-install]').addEventListener('click', async () => {
      const p = window.__installPrompt;
      window.__installPrompt = null;
      installRow.hidden = true;
      if (p) { p.prompt(); await p.userChoice.catch(() => null); }
    });
  }
  sec.querySelector('[data-apply-update]')?.addEventListener('click', () => window.__applyUpdate && window.__applyUpdate());
}

/* ---------- export period ---------- */
async function openExportSheet() {
  const last = await latestCommitted();
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p class="txn-sub" style="margin-bottom:12px;line-height:1.6">Inventory, By shelf, Low stock and Return pile always cover everything. Choose the period for the Movements sheet:</p>
    ${last ? `<button class="btn btn-block" data-p="last" style="margin-bottom:10px">Since the last count (${esc(last.label)}, ${fmtDate(last.committedAt)})</button>` : ''}
    <button class="btn btn-block" data-p="quarter" style="margin-bottom:10px">This quarter</button>
    <button class="btn btn-block" data-p="90" style="margin-bottom:10px">Last 90 days</button>
    <button class="btn btn-block" data-p="all">Everything</button>`;
  const s = sheet({ title: 'Excel export', content: wrap });
  wrap.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', async () => {
    s.close();
    const p = b.dataset.p;
    const period = p === 'last' ? { sinceTs: last.committedAt, label: `since ${last.label}` }
      : p === 'quarter' ? { sinceTs: quarterStart(), label: 'this quarter' }
      : p === '90' ? { sinceTs: Date.now() - 90 * 24 * 3600 * 1000, label: '90 days' }
      : { sinceTs: 0, label: 'all' };
    const [items, codes, locations, txns] = await Promise.all([allParts(), codesByItem(), allLocations(), allTxns()]);
    const r = await exportInventoryXlsx({ items, codesByItem: codes, locations, txns, period });
    if (r === 'shared' || r === 'downloaded') toast('Excel file exported');
  }));
}

/* ---------- import ---------- */
async function startImport(file) {
  let grid, analysis;
  const { readGrid, analyzeGrid, applyImport } = await import('../importer.js');
  try {
    grid = await readGrid(file);
    analysis = await analyzeGrid(grid, { fileName: file.name });
  } catch (e) {
    toast(e.message || 'Could not read that file', { error: true, duration: 6000 });
    return;
  }
  if (!analysis.rows.length) { toast('No part rows found in that file', { error: true }); return; }
  const locs = analysis.locations;
  const map = locationMap(locs);
  const overrides = {};
  const wrap = document.createElement('div');
  const s = sheet({ title: 'Import spreadsheet', content: wrap });

  const draw = () => {
    const rep = analysis.report;
    const shelfRows = Object.entries(rep.shelfValues).sort((a, b) => b[1] - a[1]);
    const resolvedFor = (raw) => {
      const r = analysis.rows.find(x => (x.shelfRaw || '(blank)') === raw);
      return r ? (r.locationUnknown ? '__unknown' : (r.locationId || '')) : '';
    };
    wrap.innerHTML = `
      <p style="font-size:14.5px;line-height:1.7;margin-bottom:10px">
        <b>${analysis.rows.length}</b> parts in <b>${esc(file.name)}</b> ·
        <b>${analysis.newCount}</b> new · <b>${analysis.existingCount}</b> already in the app
      </p>
      <div class="kv" style="line-height:1.7">
        <div>Barcodes: ${rep.codeStats.upc} UPC · ${rep.codeStats.ean} EAN · ${rep.codeStats.mfr + rep.codeStats.reel + rep.codeStats.manual} part-number/reel · ${rep.codeStats.none} none${rep.codeStats.fixedLeadingZero ? ` · ${rep.codeStats.fixedLeadingZero} leading zero repaired` : ''}</div>
        <div>Extra codes (aliases): ${rep.aliasCount}${rep.codeStats.precisionLost ? ` · <span style="color:var(--warn-text)">${rep.codeStats.precisionLost} lost digits in Excel (will never scan — re-scan those labels)</span>` : ''}</div>
        <div>${rep.ftCount} measured in feet · ${rep.typeCount} with a type${rep.verifyCount ? ` · <span style="color:var(--warn-text)">${rep.verifyCount} with an unclear amount</span>` : ''}</div>
        ${rep.duplicateCodes.length ? `<div style="color:var(--warn-text)">${rep.duplicateCodes.length} duplicate code(s) inside the file — second use skipped</div>` : ''}
        ${analysis.conflicts.length ? `<div style="color:var(--warn-text)">${analysis.conflicts.length} code(s) already belong to a different part here and will be skipped</div>` : ''}
      </div>
      <div class="section-title" style="margin-top:6px">Shelf column → location</div>
      <div class="set-group">
        ${shelfRows.map(([raw, n]) => `
          <div class="set-row"><div class="grow">${esc(raw)}<span class="hint">${n} part${n === 1 ? '' : 's'}</span></div>
            <select data-shelf="${esc(raw)}">
              <option value=""${resolvedFor(raw) === '' ? ' selected' : ''}>Unassigned</option>
              ${locs.map(l => `<option value="${esc(l.id)}"${resolvedFor(raw) === l.id ? ' selected' : ''}>${esc(labelOf(l, map))}</option>`).join('')}
            </select></div>`).join('')}
      </div>
      ${analysis.existingCount ? `
        <label class="set-row" style="border:1px solid var(--border);border-radius:14px;background:var(--surface);cursor:pointer;margin-bottom:12px">
          <div class="grow">Update the ${analysis.existingCount} parts already here<span class="hint">Sets their quantity and shelf from the sheet and adds missing codes</span></div>
          <span class="switch"><input type="checkbox" data-upd><span></span></span>
        </label>` : ''}
      <div class="sheet-actions">
        <button class="btn" data-cancel>Cancel</button>
        <button class="btn btn-primary" data-go>Import ${analysis.newCount}${analysis.existingCount ? ' new' : ''}</button>
      </div>`;
    wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
    wrap.querySelectorAll('[data-shelf]').forEach(sel => sel.addEventListener('change', async () => {
      overrides[String(sel.dataset.shelf === '(blank)' ? '' : sel.dataset.shelf).trim().toLowerCase()] = sel.value || null;
      analysis = await analyzeGrid(grid, { fileName: file.name, shelfOverrides: overrides });
      draw();
    }));
    wrap.querySelector('[data-go]').addEventListener('click', async () => {
      const updateExisting = !!wrap.querySelector('[data-upd]')?.checked;
      wrap.querySelector('[data-go]').disabled = true;
      try {
        const result = await applyImport(analysis, { updateExisting, fileName: file.name });
        s.close();
        const bits = [`${result.created} added`];
        if (result.updated) bits.push(`${result.updated} updated`);
        if (result.skipped) bits.push(`${result.skipped} already here`);
        if (result.codesSkipped) bits.push(`${result.codesSkipped} code(s) skipped`);
        toast(`Import done — ${bits.join(', ')}`, { duration: 6000 });
        render();
      } catch (e) {
        toast(e.message || 'Import failed', { error: true, duration: 6000 });
        wrap.querySelector('[data-go]').disabled = false;
      }
    });
  };
  draw();
}

/* ---------- restore ---------- */
function openRestoreChoice(data) {
  const wrap = document.createElement('div');
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'unknown date';
  wrap.innerHTML = `
    <p style="font-size:14.5px;line-height:1.6;margin-bottom:14px">Backup from <b>${esc(when)}</b> — ${data.items.length} parts, ${data.txns.length} movements, ${(data.counts || []).length} counts.</p>
    <button class="btn btn-block btn-primary" data-mode="replace" style="margin-bottom:10px">Replace everything on this phone</button>
    <button class="btn btn-block" data-mode="merge">Merge into this phone</button>
    <p class="txn-sub" style="margin-top:12px;line-height:1.5">Replace: this phone becomes an exact copy of the backup (recommended).<br>Merge: newest version of each record wins, all history is kept.</p>`;
  const s = sheet({ title: 'Restore backup', content: wrap });
  wrap.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', async () => {
    const mode = b.dataset.mode;
    s.close();
    if (mode === 'replace' && !(await confirmDialog('Replace everything on this phone with the backup?', { danger: true, okLabel: 'Replace' }))) return;
    try {
      const res = await restoreBackup(data, mode);
      toast(`Restored ${res.items ?? 0} parts, ${res.txns ?? 0} movements`, { duration: 4500 });
      nav.showTab('parts');
    } catch (e) { toast(e.message || 'Restore failed', { error: true }); }
  }));
}

/* ---------- deleted parts ---------- */
async function openDeletedSheet() {
  const rows = await deletedParts();
  const wrap = document.createElement('div');
  wrap.innerHTML = rows.length ? rows.map(i => `
    <div class="rev-row"><div class="rev-main">${esc(displayName(i))}<div class="txn-sub">deleted ${fmtDate(i.deletedAt)}</div></div><button class="btn btn-sm" data-restore="${i.id}">Restore</button></div>`).join('')
    : '<div class="empty">No deleted parts.</div>';
  const s = sheet({ title: 'Deleted parts', content: wrap });
  wrap.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
    await restorePart(b.dataset.restore);
    toast('Restored');
    s.close();
    render();
  }));
}

export default { show: render, refresh: render };
