/**
 * Storage — reading and writing encrypted vault backup files.
 *
 * Pure file/IO concerns: naming, encrypting/decrypting backup payloads,
 * and saving via the File System Access API or a plain download.
 *
 * Depends on the global `VaultCrypto` and `Vault` (loaded separately).
 */
const Storage = (() => {
  'use strict';

  function sanitizeFilename(name) {
    const trimmed = name.trim();
    if (!trimmed) return 'vault-backup.vault';
    const withExt = trimmed.endsWith('.vault') ? trimmed : `${trimmed}.vault`;
    return withExt.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  }

  function defaultExportFilename() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `vault-backup-${timestamp}.vault`;
  }

  function supportsSaveLocationPicker() {
    return typeof window.showSaveFilePicker === 'function';
  }

  async function buildExportContent(cryptoKey, sessionSalt, entries) {
    if (!cryptoKey || !sessionSalt) {
      throw new Error('Vault is locked. Unlock before exporting.');
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      entries,
    };

    const encrypted = await VaultCrypto.encryptWithKey(cryptoKey, sessionSalt, payload);
    return JSON.stringify(encrypted, null, 2);
  }

  async function saveBackupWithPicker(content, suggestedFilename) {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggestedFilename,
      types: [{
        description: 'Vault Backup',
        accept: { 'application/json': ['.vault'] },
      }],
    });

    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return handle.name;
  }

  async function downloadBackup(content, filename) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function parseBackupFile(file, password) {
    const text = await file.text();
    let backup;
    try {
      backup = JSON.parse(text);
    } catch {
      throw new Error('Invalid backup file. Could not parse JSON.');
    }

    const { data } = await VaultCrypto.decrypt(password, backup);
    return data.entries.map(Vault.normalizeEntry);
  }

  return {
    sanitizeFilename,
    defaultExportFilename,
    supportsSaveLocationPicker,
    buildExportContent,
    saveBackupWithPicker,
    downloadBackup,
    parseBackupFile,
  };
})();
