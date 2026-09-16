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

  // Shared timestamp-based filename builder. Both the encrypted-backup and
  // CSV filenames only differ by prefix/extension, so this is the one
  // source of truth for the timestamp format.
  function timestampedFilename(prefix, ext) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${prefix}-${timestamp}.${ext}`;
  }

  function defaultExportFilename() {
    return timestampedFilename('vault-backup', 'vault');
  }

  function defaultExportCsvFilename() {
    return timestampedFilename('vault-export', 'csv');
  }

  function supportsSaveLocationPicker() {
    return typeof window.showSaveFilePicker === 'function';
  }

  function _escapeCsvField(value) {
    if (value == null) return '';
    const str = String(value);
    if (/[,"\n]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function buildCsvContent(entries) {
    // Fields: id, site, username, password, notes
    const header = ['id', 'site', 'username', 'password', 'notes'];
    const lines = [header.join(',')];
    for (const e of entries) {
      const row = [e.id, e.site, e.username, e.password, e.notes].map(_escapeCsvField).join(',');
      lines.push(row);
    }
    return lines.join('\n');
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

  // Generic "Save As" via the File System Access API. `accept` follows
  // showSaveFilePicker's own shape: a MIME type mapped to its extensions.
  async function saveWithPicker(content, suggestedFilename, description, accept) {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggestedFilename,
      types: [{ description, accept }],
    });

    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return handle.name;
  }

  function saveBackupWithPicker(content, suggestedFilename) {
    return saveWithPicker(content, suggestedFilename, 'Vault', {
      'application/json': ['.vault'],
    });
  }

  function saveCsvWithPicker(content, suggestedFilename) {
    return saveWithPicker(content, suggestedFilename, 'Export to CSV', {
      'text/csv': ['.csv'],
    });
  }

  // Generic plain-download fallback for browsers without the picker API.
  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadBackup(content, filename) {
    return downloadFile(content, filename, 'application/json');
  }

  function downloadCsv(content, filename) {
    return downloadFile(content, filename, 'text/csv');
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
    defaultExportCsvFilename,
    supportsSaveLocationPicker,
    buildExportContent,
    buildCsvContent,
    saveBackupWithPicker,
    saveCsvWithPicker,
    downloadBackup,
    downloadCsv,
    parseBackupFile,
  };
})();
