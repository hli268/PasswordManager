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

  const $ = (sel) => document.querySelector(sel);
  const el = UI.elements;

  let autoLockMs = DEFAULT_AUTO_LOCK_MS;
  let autoLockTimer = null;
  let pendingDeleteId = null;

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

  // Manage unsaved state and persistent warning toast in one place.
  function setUnsaved(isUnsaved) {
    Vault.state.hasExported = !isUnsaved;
    if (isUnsaved) {
      // Enqueue a persistent warning; FIFO queue will ensure any immediate
      // success messages are shown first.
      UI.showToast('Unsaved changes — please save your changes before close tab.', 'warning', true);
    } else {
      // Hide any persistent unsaved notification
      UI.hideToast();
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

  async function exportBackup(filename) {
    const content = await Storage.buildExportContent(Vault.state.cryptoKey, Vault.state.sessionSalt, Vault.state.entries);
    await Storage.downloadBackup(content, filename);
    // Clear unsaved state and show success
    setUnsaved(false);
    UI.showToast(`Backup downloaded as ${filename}.`, 'success');
  }

  async function exportBackupWithLocationPicker() {
    const content = await Storage.buildExportContent(Vault.state.cryptoKey, Vault.state.sessionSalt, Vault.state.entries);
    const savedName = await Storage.saveBackupWithPicker(content, Storage.defaultExportFilename());
    // Clear unsaved state and show success
    setUnsaved(false);
    UI.showToast(`Backup saved as ${savedName}.`, 'success');
    return true;
  }

  async function mergeBackup(file, password) {
    const importedEntries = await Storage.parseBackupFile(file, password);
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

  async function importBackup(file, password) {
    const entries = await Storage.parseBackupFile(file, password);
    await Vault.createSession(password);
    Vault.setEntries(entries);
    Vault.state.hasExported = true;
    await activateVault();
    // Clear unsaved state and show success
    setUnsaved(false);
    UI.showToast(`Restored ${Vault.state.entries.length} entries from saved file.`, 'success');
  }

  function bindEvents() {
    $('#create-vault-btn').addEventListener('click', () => {
      el.createPassword.value = '';
      el.createPasswordConfirm.value = '';
      UI.hideError(el.createError);
      el.createModal.showModal();
      el.createPassword.focus();
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

    $('#create-cancel').addEventListener('click', () => el.createModal.close());

    $('#restore-btn').addEventListener('click', () => {
      el.restoreFile.value = '';
      el.restorePassword.value = '';
      UI.hideError(el.restoreError);
      el.restoreModal.showModal();
    });

    el.restoreForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.hideError(el.restoreError);

      const file = el.restoreFile.files[0];
      const password = el.restorePassword.value;
      const submitBtn = el.restoreForm.querySelector('button[type="submit"]');

      if (!file || !password) {
        UI.showError(el.restoreError, 'Please select a backup file and enter the master password.');
        return;
      }

      UI.setBusy(submitBtn, true, 'Restoring…');
      try {
        await importBackup(file, password);
        el.restoreModal.close();
        el.restorePassword.value = '';
      } catch (err) {
        UI.showError(el.restoreError, err.message);
      } finally {
        UI.setBusy(submitBtn, false);
      }
    });

    $('#restore-cancel').addEventListener('click', () => el.restoreModal.close());

    el.unlockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = el.masterPasswordInput.value;
      if (!password) {
        UI.showError(el.unlockError, 'Please enter your master password.');
        return;
      }
      await reUnlockVault(password);
    });

    $('#add-btn').addEventListener('click', () => {
      Vault.state.editingId = null;
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

      if (Vault.state.editingId) {
        Vault.updateEntry(Vault.state.editingId, { site, username, password, notes });
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

    $('#entry-cancel').addEventListener('click', () => el.entryModal.close());

    el.entryPassword.addEventListener('input', () => UI.updatePasswordStrength(el.entryPassword.value));

    $('#generate-password').addEventListener('click', () => {
      el.entryPassword.value = VaultCrypto.generatePassword();
      el.entryPassword.type = 'text';
      UI.updatePasswordStrength(el.entryPassword.value);
    });

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

    $('#export-btn').addEventListener('click', async () => {
      if (!Vault.state.cryptoKey) {
        UI.showToast('Vault is locked. Unlock to export.', 'error');
        return;
      }

      try {
        if (Storage.supportsSaveLocationPicker()) {
          try {
            const saved = await exportBackupWithLocationPicker();
            if (saved) trackActivity();
          } catch (err) {
            if (err.name === 'AbortError') return;
            throw err;
          }
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

    $('#export-cancel').addEventListener('click', () => el.exportModal.close());

    $('#merge-btn').addEventListener('click', () => {
      el.mergeFile.value = '';
      el.mergePassword.value = '';
      UI.hideError(el.mergeError);
      el.mergeModal.showModal();
    });

    el.mergeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.hideError(el.mergeError);

      const file = el.mergeFile.files[0];
      const password = el.mergePassword.value;
      const submitBtn = el.mergeForm.querySelector('button[type="submit"]');

      if (!file || !password) {
        UI.showError(el.mergeError, 'Please select a backup file and enter its master password.');
        return;
      }

      UI.setBusy(submitBtn, true, 'Merging…');
      try {
        await mergeBackup(file, password);
        el.mergeModal.close();
        el.mergePassword.value = '';
        trackActivity();
      } catch (err) {
        UI.showError(el.mergeError, err.message);
      } finally {
        UI.setBusy(submitBtn, false);
      }
    });

    $('#merge-cancel').addEventListener('click', () => el.mergeModal.close());

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
        try {
          await navigator.clipboard.writeText(entry.password);
          UI.showToast('Password copied to clipboard.', 'success');
          // Clear clipboard after a short timeout to reduce exposure
          setTimeout(async () => {
            try {
              await navigator.clipboard.writeText('');
            } catch (_) {
              // ignore failures to clear clipboard (may require user gesture)
            }
          }, 15000);
        } catch {
          UI.showToast('Could not copy to clipboard.', 'error');
        }
        trackActivity();
      }

      if (e.target.closest('.copy-user-btn')) {
        if (!entry.username) {
          UI.showToast('No username to copy.', 'info');
          return;
        }
        try {
          await navigator.clipboard.writeText(entry.username);
          UI.showToast('Username copied to clipboard.', 'success');
          // Clear clipboard after a short timeout
          setTimeout(async () => {
            try {
              await navigator.clipboard.writeText('');
            } catch (_) {
              // ignore failures
            }
          }, 15000);
        } catch {
          UI.showToast('Could not copy to clipboard.', 'error');
        }
        trackActivity();
      }

      if (e.target.closest('.edit-btn')) {
        Vault.state.editingId = entry.id;
        UI.openEntryModal(entry);
        trackActivity();
      }

      if (e.target.closest('.delete-btn')) {
        pendingDeleteId = id;
        el.deleteMessage.textContent = `Delete the entry for "${entry.site}"? This cannot be undone.`;
        el.deleteModal.showModal();
      }
    });

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
      if (Vault.state.unlocked && Vault.state.entries.length > 0 && !Vault.state.hasExported) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Only clear in-memory secrets when the page is actually being hidden/unloaded.
    window.addEventListener('pagehide', () => wipeVault());

    // Note: Native storage blocking was removed to reduce dead code. If you
    // need to prevent accidental persistence, consider adding an explicit
    // small utility module instead of overriding global Storage APIs here.
  }

  init();
})();
