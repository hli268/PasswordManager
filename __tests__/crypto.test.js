/** @jest-environment jsdom */

/**
 * Tests for crypto.js (VaultCrypto).
 *
 * jsdom does not implement SubtleCrypto, so we polyfill `crypto.subtle`
 * with Node's built-in webcrypto implementation before loading the
 * module. This lets us exercise the *real* PBKDF2/AES-GCM code paths
 * (not mocks), which is important since this is the security-critical
 * module in the app.
 */

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { TextEncoder, TextDecoder } = require('util');

beforeAll(() => {
  if (!global.crypto.subtle) {
    Object.defineProperty(global.crypto, 'subtle', { value: webcrypto.subtle });
  }
  global.TextEncoder = global.TextEncoder || TextEncoder;
  global.TextDecoder = global.TextDecoder || TextDecoder;

  let src = fs.readFileSync(path.resolve(__dirname, '..', 'crypto.js'), 'utf8');
  src = src.replace(/const\s+VaultCrypto\s*=\s*/, 'window.VaultCrypto = ');
  const scriptEl = document.createElement('script');
  scriptEl.textContent = src;
  document.body.appendChild(scriptEl);
});

describe('VaultCrypto', () => {
  test('isAvailable reports a truthy value when SubtleCrypto is present', () => {
    expect(VaultCrypto.isAvailable()).toBeTruthy();
  });

  test('encrypt/decrypt round-trips arbitrary data with the correct password', async () => {
    const data = { entries: [{ id: '1', site: 'example.com', username: 'me', password: 'p@ss' }] };
    const backup = await VaultCrypto.encrypt('correct-horse-battery-staple', data);

    expect(backup.version).toBe(1);
    expect(backup.algorithm).toBe('AES-GCM');
    expect(backup.kdf).toBe('PBKDF2');

    const { data: decrypted } = await VaultCrypto.decrypt('correct-horse-battery-staple', backup);
    expect(decrypted).toEqual(data);
  });

  test('decrypt rejects an incorrect password', async () => {
    const data = { entries: [] };
    const backup = await VaultCrypto.encrypt('right-password', data);
    await expect(VaultCrypto.decrypt('wrong-password', backup)).rejects.toThrow(
      /Incorrect master password/
    );
  });

  test('decrypt rejects a backup with an unsupported/missing version', async () => {
    const data = { entries: [] };
    const backup = await VaultCrypto.encrypt('pw', data);
    backup.version = 99;
    await expect(VaultCrypto.decrypt('pw', backup)).rejects.toThrow(
      /Invalid or unsupported backup file format/
    );
  });

  test('decrypt rejects a backup whose entries are not an array', async () => {
    const backup = await VaultCrypto.encrypt('pw', { entries: 'not-an-array' });
    await expect(VaultCrypto.decrypt('pw', backup)).rejects.toThrow(
      /does not contain valid vault data/
    );
  });

  test('decrypt rejects tampered ciphertext', async () => {
    const backup = await VaultCrypto.encrypt('pw', { entries: [] });
    // Flip a base64 character in the ciphertext to corrupt it.
    const chars = backup.ciphertext.split('');
    const idx = Math.floor(chars.length / 2);
    chars[idx] = chars[idx] === 'A' ? 'B' : 'A';
    backup.ciphertext = chars.join('');

    await expect(VaultCrypto.decrypt('pw', backup)).rejects.toThrow();
  });

  test('createSession + unlockSession succeeds with the right password', async () => {
    const session = await VaultCrypto.createSession('my-master-password');
    expect(session.sessionSalt).toBeInstanceOf(Uint8Array);
    expect(session.verifier.iv).toEqual(expect.any(String));
    expect(session.verifier.ciphertext).toEqual(expect.any(String));

    const key = await VaultCrypto.unlockSession('my-master-password', session.sessionSalt, session.verifier);
    expect(key).toBeTruthy();
  });

  test('unlockSession throws on wrong password', async () => {
    const session = await VaultCrypto.createSession('my-master-password');
    await expect(
      VaultCrypto.unlockSession('totally-wrong', session.sessionSalt, session.verifier)
    ).rejects.toThrow(/Incorrect master password/);
  });

  test('encryptWithKey produces a v2 backup decryptable with the same password', async () => {
    const session = await VaultCrypto.createSession('session-pw');
    const payload = { exportedAt: '2024-01-01', entries: [{ id: 'a', site: 's', username: 'u', password: 'p', notes: '' }] };
    const backup = await VaultCrypto.encryptWithKey(session.cryptoKey, session.sessionSalt, payload);

    expect(backup.version).toBe(2);
    const { data } = await VaultCrypto.decrypt('session-pw', backup);
    expect(data).toEqual(payload);
  });

  describe('scorePassword', () => {
    test('empty password scores 0 / Enter a password', () => {
      expect(VaultCrypto.scorePassword('')).toEqual({
        score: 0,
        label: 'Enter a password',
        className: 'strength-empty',
      });
    });

    test('short simple password is Weak', () => {
      const result = VaultCrypto.scorePassword('abc');
      expect(result.className).toBe('strength-weak');
    });

    test('long password with mixed case, digits, and symbols is Strong', () => {
      const result = VaultCrypto.scorePassword('Aa1!Aa1!Aa1!Aa1!');
      expect(result.className).toBe('strength-strong');
    });

    test('score is monotonic non-decreasing as complexity increases', () => {
      const weak = VaultCrypto.scorePassword('aaaaaaaa');
      const stronger = VaultCrypto.scorePassword('Aa1!aaaa');
      expect(stronger.score).toBeGreaterThanOrEqual(weak.score);
    });
  });

  describe('generatePassword', () => {
    test('defaults to length 20', () => {
      expect(VaultCrypto.generatePassword()).toHaveLength(20);
    });

    test('respects a custom length', () => {
      expect(VaultCrypto.generatePassword(8)).toHaveLength(8);
      expect(VaultCrypto.generatePassword(32)).toHaveLength(32);
    });

    test('only uses characters from the expected charset', () => {
      const allowed = /^[A-Za-z0-9!@#$%^&*()\-_=+[\]{}]+$/;
      const pw = VaultCrypto.generatePassword(100);
      expect(pw).toMatch(allowed);
    });

    test('generates different passwords on successive calls (extremely unlikely to collide)', () => {
      const a = VaultCrypto.generatePassword();
      const b = VaultCrypto.generatePassword();
      expect(a).not.toBe(b);
    });
  });

  describe('generateId', () => {
    test('returns a 32-char hex string (16 bytes)', () => {
      const id = VaultCrypto.generateId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    test('generates unique ids across many calls', () => {
      const ids = new Set(Array.from({ length: 200 }, () => VaultCrypto.generateId()));
      expect(ids.size).toBe(200);
    });
  });
});
