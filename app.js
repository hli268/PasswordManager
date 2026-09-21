/**
 * App — session-only password manager entry point.
 * All data lives in memory and is wiped on page close.
 *
 * Wires together Vault (state/logic), Storage (backup file I/O), and UI
 * (DOM rendering), and owns app-level behavior: auto-lock, activity
 * tracking, and the unsaved-changes warning.
 *
 * Depends on the globals `VaultCrypto`, `Vault`, `Storage`, and `UI`
 * (loaded separately, in that order).
 */
(() => {
  'use strict';

  // Note: test-related polyfills were removed. Tests should provide real File
  // objects or use DataTransfer to set input.files.

  const DEFAULT_AUTO_LOCK_MS = 5 * 60 * 1000;
  const CLIPBOARD_CLEAR_MS = 15 * 1000;

  const $ = (sel) => document.querySelector(sel);
  const el = UI.elements;

  let autoLockMs = DEFAULT_AUTO_LOCK_MS;
  let autoLockTimer = null;
  let pendingDeleteId = null;
  let clipboardClearTimer = null;

  function init() {
    if (!VaultCrypto.isAvailable()) {
      UI.showToast('Web Crypto is unavailable. Open via http://localhost, not file://.', 'error');
      return;
    }

    bindEvents();
    el.autoLockSelect.value = String(DEFAULT_AUTO_LOCK_MS);
    UI.showScreen('welcome');
  }

  function resetAutoLockTimer() {
    clearTimeout(autoLockTimer);
    if (!Vault.state.unlocked) return;
    autoLockTimer = setTimeout(() => lockVault('Vault locked due to inactivity.'), autoLockMs);
  }

  function stopAutoLockTimer() {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }

  function trackActivity() {
    if (Vault.state.unlocked) resetAutoLockTimer();
  }

  // Manage unsaved state and the persistent warning banner in one place.
  // The banner lives outside the toast queue (see ui.js) specifically so it
  // can stay visible indefinitely without blocking other toasts.
  function setUnsaved(isUnsaved) {
    if (isUnsaved) {
      Vault.markUnexported();
      UI.showUnsavedBanner();
    } else {
      Vault.markExported();
      UI.hideUnsavedBanner();
    }
  }

  // Re-derives the filtered/sorted entry list from current search + sort
  // controls and re-renders it.
  function refreshEntries() {
    const query = el.searchInput.value;
    const filtered = Vault.filterEntries(Vault.state.entries, query);
    const sorted = Vault.sortEntries(filtered, el.sortSelect.value);
    UI.renderEntries(sorted, {
      totalCount: Vault.state.entries.length,
      query: query.toLowerCase().trim(),
    });
  }

  async function activateVault() {
    UI.showScreen('vault');
    refreshEntries();
    resetAutoLockTimer();
  }

  async function createVault(password) {
    await Vault.createSession(password);
    await activateVault();
    UI.showToast('Vault created. Save a backup before closing this tab.', 'info');
  }

  async function reUnlockVault(password) {
    try {
      await Vault.unlock(password);
      UI.resetUnlockForm();
      UI.showScreen('vault');
      refreshEntries();
      resetAutoLockTimer();
      return true;
    } catch (err) {
      UI.showError(el.unlockError, err.message || 'Incorrect master password.');
      return false;
    }
  }

  function lockVault(message = 'Vault locked.') {
    Vault.lock();
    stopAutoLockTimer();
    UI.clearRevealTimer();
    UI.resetUnlockForm();
    UI.showScreen('unlock');
    UI.showToast(message, 'info');
  }

  function wipeVault() {
    Vault.reset();
    UI.clearEntriesDisplay();
    stopAutoLockTimer();
    UI.clearRevealTimer();
  }

  // --- Export helpers -------------------------------------------------
  // The encrypted .vault backup is the vault's real persisted
  // representation, so only it clears the "unsaved changes" state.
  // A CSV export is a lossy, unencrypted side-export (see the CSV warning
  // modal) rather than a substitute backup, so it intentionally leaves the
  // unsaved banner up.
  function finishExport(successMessage, clearUnsaved = true) {
    if (clearUnsaved) {
      setUnsaved(false);
    }
    UI.showToast(successMessage, 'success');
  }

  // Runs `fn` and swallows a user-cancelled showSaveFilePicker() dialog
  // (AbortError), which both the backup and CSV picker flows need to do.
  async function runIfNotAborted(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.name === 'AbortError') return undefined;
      throw err;
    }
  }

  function requireUnlockedForExport() {
    if (!Vault.state.cryptoKey) {
      UI.showToast('Vault is locked. Unlock to export.', 'error');
      return false;
    }
    return true;
  }

  async function exportBackup(filename) {
    const content = await Storage.buildExportContent(Vault.state.cryptoKey, Vault.state.sessionSalt, Vault.state.entries);
    await Storage.downloadBackup(content, filename);
    finishExport(`Backup downloaded as ${filename}.`);
  }

  async function exportBackupWithLocationPicker() {
    const content = await Storage.buildExportContent(Vault.state.cryptoKey, Vault.state.sessionSalt, Vault.state.entries);
    const savedName = await Storage.saveBackupWithPicker(content, Storage.defaultExportFilename());
    finishExport(`Backup saved as ${savedName}.`);
    return true;
  }

  async function exportCsvWithLocationPicker() {
    const content = await Storage.buildCsvContent(Vault.state.entries);
    const savedName = await Storage.saveCsvWithPicker(content, Storage.defaultExportCsvFilename());
    finishExport(`CSV exported as ${savedName}.`, false);
    return true;
  }

  async function exportCsvDownload() {
    const content = await Storage.buildCsvContent(Vault.state.entries);
    const filename = Storage.defaultExportCsvFilename();
    await Storage.downloadCsv(content, filename);
    finishExport(`CSV exported as ${filename}.`, false);
  }

  // --- Clipboard helper -------------------------------------------------
  // Shared by the per-entry "copy password" and "copy username" buttons:
  // write to the clipboard, toast, then clear it shortly after to reduce
  // exposure. Uses a single shared timer (rather than one per copy) so that
  // copying a second value shortly after the first reschedules the clear
  // instead of wiping the clipboard early based on the first copy's timer.
  let clipboardClearPending = false;

  // Returns true if the clipboard was cleared. Never triggers a permission prompt.
  async function clearClipboardSilently() {
    try {
      if (navigator.permissions?.query && !navigator.userActivation?.isActive) {
        const status = await navigator.permissions.query({ name: 'clipboard-write' });
        if (status.state !== 'granted') {
          console.debug('Clipboard clear deferred, permission:', status.state);
          return false;
        }
      }
    } catch (_) { /* permission can't be queried in this browser; just try the write */ }

    try {
      await navigator.clipboard.writeText('');
      return true;
    } catch (err) {
      // Typically "Document is not focused" while the user is in another app.
      console.debug('Clipboard clear failed:', err.name, err.message);
      return false;
    }
  }

  async function attemptPendingClipboardClear() {
    if (!clipboardClearPending) return;
    if (await clearClipboardSilently()) clipboardClearPending = false;
  }
 
 async function copyToClipboard(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      UI.showToast(`${label} copied to clipboard.`, 'success');
 
      // A new copy replaces whatever was pending, so it must not be cleared early.
      clipboardClearPending = false;
      clearTimeout(clipboardClearTimer);
      clipboardClearTimer = setTimeout(async () => {
        clipboardClearTimer = null;
        clipboardClearPending = !(await clearClipboardSilently());
      }, CLIPBOARD_CLEAR_MS);
    } catch {
      UI.showToast('Could not copy to clipboard.', 'error');
    }
  }
 
  // --- Modal helpers ------------------------------------------------
  // Shared "reset a few fields, hide the error, open the dialog" flow used
  // by the create/restore/merge trigger buttons.
  function openResetModal(modalEl, { resetFields = [], errorEl, focusEl } = {}) {
    resetFields.forEach((input) => { input.value = ''; });
    if (errorEl) UI.hideError(errorEl);
    modalEl.showModal();
    if (focusEl) focusEl.focus();
  }

  function wireCancel(buttonSel, modalEl) {
    $(buttonSel).addEventListener('click', () => modalEl.close());
  }

  // Shared "pick a backup file + master password, validate, run an async
  // action while busy, surface any error" flow used by both the restore
  // and merge forms — they only differ in which fields/action/messages.
  async function handleBackupFileSubmit({ form, fileInput, passwordInput, errorEl, busyText, missingMessage, action, onSuccess }) {
    UI.hideError(errorEl);

    const file = fileInput.files[0];
    const password = passwordInput.value;
    const submitBtn = form.querySelector('button[type="submit"]');

    if (!file || !password) {
      UI.showError(errorEl, missingMessage);
      return;
    }

    UI.setBusy(submitBtn, true, busyText);
    try {
      await action(file, password);
      passwordInput.value = '';
      onSuccess?.();
    } catch (err) {
      UI.showError(errorEl, err.message);
    } finally {
      UI.setBusy(submitBtn, false);
    }
  }

  async function mergeBackup(file, password) {
    const importedEntries = await Storage.parseBackupFile(file, password, Vault.normalizeEntry);
    const { toAdd, conflicts } = Vault.buildMergePlan(Vault.state.entries, importedEntries);

    if (toAdd.length === 0 && conflicts.length === 0) {
      UI.showToast('No new entries to merge.', 'info');
      return;
    }

    let resolutions = {};
    if (conflicts.length > 0) {
      const result = await UI.showConflictModal(conflicts);
      if (!result) {
        UI.showToast('Merge cancelled.', 'info');
        return;
      }
      resolutions = result;
    }

    const { added, updated } = Vault.applyMerge(toAdd, conflicts, resolutions);
    refreshEntries();

    const parts = [];
    if (added > 0) parts.push(`${added} added`);
    if (updated > 0) parts.push(`${updated} updated`);
    UI.showToast(`Merge complete: ${parts.join(', ') || 'no changes'}.`, 'success');

    // If merge actually changed entries, mark as unsaved and notify the user
    if (added > 0 || updated > 0) {
      setUnsaved(true);
    }
  }

  // CSV import: unlike mergeBackup above, a CSV file is plaintext, so there's
  // no password to collect and nothing to decrypt, and there's no conflict
  // modal. Each parsed row is checked against the vault's current entries
  // (matching on site+username+notes, case-insensitive/trimmed — see
  // Vault.findMatchByKeyAndNotes) and handled as one of:
  //   - no match: a genuinely new entry, so it's added.
  //   - match with the same password too: an exact duplicate of an entry
  //     already in memory, so it's skipped silently.
  //   - match but the password differs: skipped as well (the existing
  //     password is left alone — importing never overwrites), but reported
  //     back via a dedicated toast so it isn't a silent, surprising drop.
  // Entries added this way live in memory exactly like any other entry, and
  // get encrypted the normal way the next time the vault is exported as an
  // encrypted .vault backup.
  async function importCsv(fileInput) {
    const file = fileInput.files[0];
    fileInput.value = ''; // allow re-selecting the same file later
    if (!file) return;

    try {
      const { entries: parsedEntries, skipped: invalidRows } = await Storage.parseCsvFile(file);

      let added = 0;
      let duplicates = 0;
      const passwordMismatchSites = [];

      for (const candidate of parsedEntries) {
        // Compare against the vault's live entries (including ones already
        // added earlier in this same loop), so duplicate rows within one
        // CSV file are caught the same way as duplicates of pre-existing
        // entries.
        const match = Vault.findMatchByKeyAndNotes(Vault.state.entries, candidate);

        if (!match) {
          Vault.addEntry(candidate);
          added += 1;
        } else if (match.password === candidate.password) {
          duplicates += 1;
        } else {
          passwordMismatchSites.push(candidate.site);
        }
      }

      if (added > 0) {
        refreshEntries();
        setUnsaved(true);
      }

      const parts = [];
      if (added > 0) parts.push(`${added} added`);
      if (duplicates > 0) parts.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped`);
      if (passwordMismatchSites.length > 0) {
        parts.push(`${passwordMismatchSites.length} skipped (password differs)`);
      }
      if (invalidRows > 0) parts.push(`${invalidRows} invalid skipped`);

      const message = parts.length > 0
        ? `CSV import complete: ${parts.join(', ')}.`
        : 'CSV file had no entries to import.';
      UI.showToast(message, added > 0 ? 'success' : 'info');

      if (passwordMismatchSites.length > 0) {
        const MAX_LISTED_SITES = 3;
        const shown = passwordMismatchSites.slice(0, MAX_LISTED_SITES).join(', ');
        const remaining = passwordMismatchSites.length - MAX_LISTED_SITES;
        const suffix = remaining > 0 ? `, and ${remaining} more` : '';
        UI.showToast(
            `Password mismatch entries not imported: ${shown}${suffix}.`,
            'warning'
        );
      }

      // Warn about any other skipped rows (exact duplicates and invalid
      // rows). Password mismatches already get their own, more detailed
      // warning above, so they aren't repeated here.
      const otherSkipped = [];
      if (duplicates > 0) otherSkipped.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'}`);
      if (invalidRows > 0) otherSkipped.push(`${invalidRows} invalid row${invalidRows === 1 ? '' : 's'}`);

      if (otherSkipped.length > 0) {
        UI.showToast(`Skipped ${otherSkipped.join(' and ')} during CSV import.`, 'warning');
      }

      trackActivity();
    } catch (err) {
      UI.showToast(err.message || 'Failed to import CSV.', 'error');
    }
  }

  async function importBackup(file, password) {
    const entries = await Storage.parseBackupFile(file, password, Vault.normalizeEntry);
    await Vault.createSession(password);
    Vault.setEntries(entries);
    Vault.markExported();
    await activateVault();
    finishExport(`Restored ${Vault.state.entries.length} entries from saved file.`);
  }

  // --- Event binding ----------------------------------------------------
  // Split by feature area instead of one long function, purely for
  // readability/navigation — behavior is unchanged from before the split.

  function bindCreateVaultEvents() {
    $('#create-vault-btn').addEventListener('click', () => {
      openResetModal(el.createModal, {
        resetFields: [el.createPassword, el.createPasswordConfirm],
        errorEl: el.createError,
        focusEl: el.createPassword,
      });
    });

    el.createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.hideError(el.createError);

      const password = el.createPassword.value;
      const confirm = el.createPasswordConfirm.value;
      const submitBtn = el.createForm.querySelector('button[type="submit"]');

      if (!password) {
        UI.showError(el.createError, 'Please enter a master password.');
        return;
      }

      if (password.length < VaultCrypto.MIN_MASTER_PASSWORD_LENGTH) {
        UI.showError(el.createError, `Master password must be at least ${VaultCrypto.MIN_MASTER_PASSWORD_LENGTH} characters.`);
        return;
      }

      if (password !== confirm) {
        UI.showError(el.createError, 'Passwords do not match.');
        return;
      }

      UI.setBusy(submitBtn, true, 'Creating…');
      try {
        el.createModal.close();
        await createVault(password);
      } catch (err) {
        UI.showError(el.createError, err.message || 'Failed to create vault.');
        el.createModal.showModal();
      } finally {
        UI.setBusy(submitBtn, false);
      }
    });

    wireCancel('#create-cancel', el.createModal);
  }

  function bindRestoreEvents() {
    $('#restore-btn').addEventListener('click', () => {
      openResetModal(el.restoreModal, {
        resetFields: [el.restoreFile, el.restorePassword],
        errorEl: el.restoreError,
      });
    });

    el.restoreForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleBackupFileSubmit({
        form: el.restoreForm,
        fileInput: el.restoreFile,
        passwordInput: el.restorePassword,
        errorEl: el.restoreError,
        busyText: 'Restoring…',
        missingMessage: 'Please select a backup file and enter the master password.',
        action: importBackup,
        onSuccess: () => el.restoreModal.close(),
      });
    });

    wireCancel('#restore-cancel', el.restoreModal);
  }

  function bindUnlockEvents() {
    el.unlockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = el.masterPasswordInput.value;
      if (!password) {
        UI.showError(el.unlockError, 'Please enter your master password.');
        return;
      }
      await reUnlockVault(password);
    });
  }

  function bindEntryFormEvents() {
    $('#add-btn').addEventListener('click', () => {
      Vault.setEditingId(null);
      UI.openEntryModal();
    });

    el.entryForm.addEventListener('submit', (e) => {
      e.preventDefault();
      UI.hideError(el.entryError);

      // Coerce and normalize inputs to strings to avoid runtime errors later
      const site = String(el.entrySite.value || '').trim();
      const username = String(el.entryUsername.value || '').trim();
      const password = String(el.entryPassword.value || '');
      const notes = String(el.entryNotes.value || '').trim();

      if (!site) {
        UI.showError(el.entryError, 'Site / service name is required.');
        return;
      }

      if (!password) {
        UI.showError(el.entryError, 'Password is required.');
        return;
      }
      
      if (password.includes(',')) {
        UI.showError(el.entryError, 'Password cannot contain a comma (it is used as the CSV field separator).');
        return;
      }

      if (/^[ \t]|[ \t]$/.test(password)) {
        UI.showError(el.entryError, 'Password cannot start or end with a space or tab.');
        return;
      }

      const editingId = Vault.getEditingId();
      if (editingId) {
        Vault.updateEntry(editingId, { site, username, password, notes });
        UI.showToast('Entry updated.', 'success');
      } else {
        Vault.addEntry({ site, username, password, notes });
        UI.showToast('Entry added.', 'success');
      }

      // Mark vault as having unsaved changes and notify the user
      setUnsaved(true);

      el.entryModal.close();
      refreshEntries();
      trackActivity();
    });

    wireCancel('#entry-cancel', el.entryModal);

    el.entryPassword.addEventListener('input', () => UI.updatePasswordStrength(el.entryPassword.value));

    $('#generate-password').addEventListener('click', () => {
      el.entryPassword.value = VaultCrypto.generatePassword();
      el.entryPassword.type = 'text';
      UI.updatePasswordStrength(el.entryPassword.value);
    });
  }

  function bindSearchSortEvents() {
    el.searchInput.addEventListener('input', () => {
      refreshEntries();
      trackActivity();
    });

    el.sortSelect.addEventListener('change', () => refreshEntries());

    el.autoLockSelect.addEventListener('change', () => {
      autoLockMs = Number(el.autoLockSelect.value);
      resetAutoLockTimer();
      trackActivity();
    });
  }

  function bindExportEvents() {
    $('#export-btn').addEventListener('click', async () => {
      if (!requireUnlockedForExport()) return;

      try {
        if (Storage.supportsSaveLocationPicker()) {
          const saved = await runIfNotAborted(exportBackupWithLocationPicker);
          if (saved) trackActivity();
          return;
        }

        el.exportFilename.value = Storage.defaultExportFilename();
        UI.hideError(el.exportError);
        el.exportModal.showModal();
        el.exportFilename.focus();
        el.exportFilename.select();
      } catch (err) {
        UI.showToast(err.message || 'Failed to save backup file.', 'error');
      }
    });

    el.exportForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.hideError(el.exportError);

      const filename = Storage.sanitizeFilename(el.exportFilename.value);
      const submitBtn = el.exportForm.querySelector('button[type="submit"]');

      if (!Vault.state.cryptoKey) {
        el.exportModal.close();
        return;
      }

      UI.setBusy(submitBtn, true, 'Exporting…');
      try {
        await exportBackup(filename);
        el.exportModal.close();
        trackActivity();
      } catch (err) {
        UI.showError(el.exportError, err.message || 'Failed to save backup file.');
      } finally {
        UI.setBusy(submitBtn, false);
      }
    });

    wireCancel('#export-cancel', el.exportModal);

    $('#export-csv-btn').addEventListener('click', () => {
      if (!requireUnlockedForExport()) return;
      el.exportCsvWarningModal.showModal();
    });

    wireCancel('#cancel-export-csv', el.exportCsvWarningModal);

    el.exportCsvWarningConfirm.addEventListener('click', async () => {
      UI.setBusy(el.exportCsvWarningConfirm, true, 'Exporting…');
      try {
        if (Storage.supportsSaveLocationPicker()) {
          await runIfNotAborted(exportCsvWithLocationPicker);
        } else {
          await exportCsvDownload();
        }
        el.exportCsvWarningModal.close();
        trackActivity();
      } catch (err) {
        UI.showToast(err.message || 'Failed to export CSV.', 'error');
      } finally {
        UI.setBusy(el.exportCsvWarningConfirm, false);
      }
    });
  }

  function bindMergeEvents() {
    $('#merge-btn').addEventListener('click', () => {
      openResetModal(el.mergeModal, {
        resetFields: [el.mergeFile, el.mergePassword],
        errorEl: el.mergeError,
      });
    });

    el.mergeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleBackupFileSubmit({
        form: el.mergeForm,
        fileInput: el.mergeFile,
        passwordInput: el.mergePassword,
        errorEl: el.mergeError,
        busyText: 'Merging…',
        missingMessage: 'Please select a backup file and enter its master password.',
        action: mergeBackup,
        onSuccess: () => { el.mergeModal.close(); trackActivity(); },
      });
    });

    wireCancel('#merge-cancel', el.mergeModal);

    // CSV import chevron: no modal, no password — straight to the native
    // file picker. The vault is only reachable (and this button only
    // visible) once unlocked, same as the encrypted-backup merge above.
    el.mergeCsvBtn.addEventListener('click', () => {
      el.mergeCsvFile.click();
    });

    el.mergeCsvFile.addEventListener('change', () => importCsv(el.mergeCsvFile));
  }

  function bindLockAndDeleteEvents() {
    $('#lock-btn').addEventListener('click', () => lockVault());

    el.deleteForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (pendingDeleteId) {
        Vault.deleteEntry(pendingDeleteId);
        pendingDeleteId = null;
        el.deleteModal.close();
        refreshEntries();
        UI.showToast('Entry deleted.', 'success');

        // Mark vault as having unsaved changes and notify the user
        setUnsaved(true);

        trackActivity();
      }
    });

    $('#delete-cancel').addEventListener('click', () => {
      pendingDeleteId = null;
      el.deleteModal.close();
    });
  }

  function bindEntriesListEvents() {
    el.entriesList.addEventListener('click', async (e) => {
      const card = e.target.closest('.entry-card');
      if (!card) return;

      const id = card.dataset.id;
      const entry = Vault.findEntry(id);
      if (!entry) return;

      if (e.target.closest('.reveal-btn')) {
        const span = card.querySelector('.entry-password');
        const isMasked = span.classList.contains('masked');
        if (isMasked) {
          span.textContent = entry.password;
          span.classList.remove('masked');
          UI.scheduleReMask();
        } else {
          span.textContent = '••••••••';
          span.classList.add('masked');
        }
        trackActivity();
      }

      if (e.target.closest('.copy-btn')) {
        await copyToClipboard(entry.password, 'Password');
        trackActivity();
      }

      if (e.target.closest('.copy-user-btn')) {
        if (!entry.username) {
          UI.showToast('No username to copy.', 'info');
          return;
        }
        await copyToClipboard(entry.username, 'Username');
        trackActivity();
      }

      if (e.target.closest('.edit-btn')) {
        Vault.setEditingId(entry.id);
        UI.openEntryModal(entry);
        trackActivity();
      }

      if (e.target.closest('.delete-btn')) {
        pendingDeleteId = id;
        el.deleteMessage.textContent = `Delete the entry for "${entry.site}"? This cannot be undone.`;
        el.deleteModal.showModal();
      }
    });
  }

  function bindGlobalEvents() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.toggle-visibility');
      if (!btn) return;
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.querySelector('.eye-open').classList.toggle('hidden', isPassword);
      btn.querySelector('.eye-closed').classList.toggle('hidden', !isPassword);
    });

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach((event) => {
      document.addEventListener(event, trackActivity, { passive: true });
    });

    // Show native leave-site confirmation when there are unsaved entries.
    // Do NOT wipe the in-memory vault here — the user may cancel navigation and expect data to remain.
    window.addEventListener('beforeunload', (e) => {
      if (Vault.state.entries.length > 0 && !Vault.state.hasExported) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Only clear in-memory secrets when the page is actually being hidden/unloaded.
    window.addEventListener('pagehide', () => wipeVault());

    // If the 15s clear couldn't run (page unfocused / no permission), finish it
    // as soon as the user is back on the page.
    window.addEventListener('focus', attemptPendingClipboardClear);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') attemptPendingClipboardClear();
    });    
    ['click', 'keydown', 'touchend'].forEach((evt) => {
      document.addEventListener(evt, attemptPendingClipboardClear, { passive: true });
    });

    // Note: Native storage blocking was removed to reduce dead code. If you
    // need to prevent accidental persistence, consider adding an explicit
    // small utility module instead of overriding global Storage APIs here.
  }

  function bindEvents() {
    bindCreateVaultEvents();
    bindRestoreEvents();
    bindUnlockEvents();
    bindEntryFormEvents();
    bindSearchSortEvents();
    bindExportEvents();
    bindMergeEvents();
    bindLockAndDeleteEvents();
    bindEntriesListEvents();
    bindGlobalEvents();
  }

  init();
})();
