/**
 * Encryption utilities using Web Crypto API.
 * Session keys are derived from the master password; backups are encrypted with AES-GCM + PBKDF2.
 */
const VaultCrypto = (() => {
  const PBKDF2_ITERATIONS = 600000;
  const SALT_LENGTH = 16;
  const IV_LENGTH = 12;
  const BACKUP_VERSION_V1 = 1;
  const BACKUP_VERSION_V2 = 2;
  const VERIFIER_PLAINTEXT = 'vault-session-verified';
  const MIN_MASTER_PASSWORD_LENGTH = 12;

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  function fromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function generateSalt() {
    return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  }

  async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function createVerifier(cryptoKey) {
    const iv = generateSalt().slice(0, IV_LENGTH);
    const encoder = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      encoder.encode(VERIFIER_PLAINTEXT)
    );

    return {
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
    };
  }

  async function verifyVaultKey(cryptoKey, verifier) {
    try {
      const iv = new Uint8Array(fromBase64(verifier.iv));
      const ciphertext = fromBase64(verifier.ciphertext);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        ciphertext
      );
      const decoder = new TextDecoder();
      return decoder.decode(decrypted) === VERIFIER_PLAINTEXT;
    } catch {
      return false;
    }
  }

  async function createSession(password) {
    const sessionSalt = generateSalt();
    const cryptoKey = await deriveKey(password, sessionSalt);
    const verifier = await createVerifier(cryptoKey);

    return { sessionSalt, cryptoKey, verifier };
  }

  async function unlockSession(password, sessionSalt, verifier) {
    const cryptoKey = await deriveKey(password, sessionSalt);
    const valid = await verifyVaultKey(cryptoKey, verifier);
    if (!valid) {
      throw new Error('Incorrect master password.');
    }
    return cryptoKey;
  }

  async function encryptWithKey(cryptoKey, sessionSalt, data) {
    const iv = generateSalt().slice(0, IV_LENGTH);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(data));

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      plaintext
    );

    return {
      version: BACKUP_VERSION_V2,
      algorithm: 'AES-GCM',
      kdf: 'PBKDF2',
      iterations: PBKDF2_ITERATIONS,
      salt: toBase64(sessionSalt),
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
    };
  }

  async function encrypt(password, data) {
    const salt = generateSalt();
    const iv = generateSalt().slice(0, IV_LENGTH);
    const key = await deriveKey(password, salt);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(data));

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );

    return {
      version: BACKUP_VERSION_V1,
      algorithm: 'AES-GCM',
      kdf: 'PBKDF2',
      iterations: PBKDF2_ITERATIONS,
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
    };
  }

  async function decrypt(password, backup) {
    if (!backup || (backup.version !== BACKUP_VERSION_V1 && backup.version !== BACKUP_VERSION_V2)) {
      throw new Error('Invalid or unsupported backup file format.');
    }

    const salt = new Uint8Array(fromBase64(backup.salt));
    const iv = new Uint8Array(fromBase64(backup.iv));
    const key = await deriveKey(password, salt);
    const ciphertext = fromBase64(backup.ciphertext);

    let decrypted;
    try {
      decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
    } catch {
      throw new Error('Incorrect master password or corrupted backup file.');
    }

    const decoder = new TextDecoder();
    const parsed = JSON.parse(decoder.decode(decrypted));

    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new Error('Backup file does not contain valid vault data.');
    }

    return { data: parsed, sessionSalt: salt };
  }

  function scorePassword(password) {
    if (!password) {
      return { score: 0, label: 'Enter a password', className: 'strength-empty' };
    }

    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (password.length >= 16) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^A-Za-z0-9]/.test(password)) score += 1;

    if (score <= 2) return { score, label: 'Weak', className: 'strength-weak' };
    if (score <= 4) return { score, label: 'Fair', className: 'strength-fair' };
    if (score <= 5) return { score, label: 'Good', className: 'strength-good' };
    return { score, label: 'Strong', className: 'strength-strong' };
  }

  function generatePassword(length = 20) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}';
    const charsetLength = charset.length;
    const maxValid = Math.floor(256 / charsetLength) * charsetLength;
    const result = [];

    while (result.length < length) {
      const random = crypto.getRandomValues(new Uint8Array(length));
      for (const byte of random) {
        if (byte >= maxValid) continue;
        result.push(charset[byte % charsetLength]);
        if (result.length === length) break;
      }
    }

    return result.join('');
  }

  function generateId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function isAvailable() {
    return typeof crypto !== 'undefined' && crypto.subtle;
  }

  return {
    encrypt,
    encryptWithKey,
    decrypt,
    createSession,
    unlockSession,
    scorePassword,
    generatePassword,
    generateId,
    isAvailable,
    MIN_MASTER_PASSWORD_LENGTH,
  };
})();
