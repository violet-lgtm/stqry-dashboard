/**
 * The translation dictionaries.
 *
 * The failure mode these guard against is drift: a string added to one
 * language and forgotten in the other shows an untranslated key on screen.
 * The placeholder check matters just as much — a `{count}` that exists in one
 * language and not the other renders a literal brace to the reader.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The module touches `localStorage` and `document` at import time, so it is
// read as text and evaluated with the browser globals stubbed out.
const source = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');

globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.get(k) ?? null; },
  setItem(k, v) { this.store.set(k, v); },
};
globalThis.document = { documentElement: {} };

const i18n = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const { __strings: STRINGS, LANGUAGES, DEFAULT_LANGUAGE, t, setLanguage, translateCode } = i18n;

const placeholders = (value) => (value.match(/\{(\w+)\}/g) || []).sort();

describe('translations', () => {
  test('Dutch is the default', () => {
    assert.equal(DEFAULT_LANGUAGE, 'nl');
  });

  test('every language has exactly the same keys', () => {
    const reference = Object.keys(STRINGS[DEFAULT_LANGUAGE]).sort();
    for (const language of LANGUAGES) {
      const keys = Object.keys(STRINGS[language]).sort();
      const missing = reference.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !reference.includes(k));
      assert.deepEqual(missing, [], `${language} is missing keys`);
      assert.deepEqual(extra, [], `${language} has keys no other language has`);
    }
  });

  test('matching keys take the same placeholders', () => {
    for (const key of Object.keys(STRINGS[DEFAULT_LANGUAGE])) {
      const reference = placeholders(STRINGS[DEFAULT_LANGUAGE][key]);
      for (const language of LANGUAGES) {
        assert.deepEqual(placeholders(STRINGS[language][key]), reference, `"${key}" in ${language}`);
      }
    }
  });

  test('no string is left empty', () => {
    for (const language of LANGUAGES) {
      for (const [key, value] of Object.entries(STRINGS[language])) {
        assert.ok(value.trim().length > 0, `"${key}" is empty in ${language}`);
      }
    }
  });

  test('the two languages actually differ', () => {
    // A guard against a dictionary copied and never translated.
    const identical = Object.keys(STRINGS.nl).filter((k) => STRINGS.nl[k] === STRINGS.en[k]);
    // Proper nouns and codes legitimately match; anything more means a copy.
    assert.ok(identical.length < 6, `suspiciously many identical strings: ${identical.join(', ')}`);
  });

  test('every error and mock code the server can send is translated', () => {
    // These must stay in step with describeError() and config.mockReasonCode.
    const errorCodes = [
      'PERMISSION_DENIED', 'UNAUTHENTICATED', 'NOT_FOUND',
      'INVALID_ARGUMENT', 'RESOURCE_EXHAUSTED', 'BAD_PRIVATE_KEY', 'UNKNOWN',
    ];
    const mockCodes = ['FORCED', 'NO_PROPERTY', 'NO_CREDENTIALS'];
    for (const language of LANGUAGES) {
      for (const code of errorCodes) {
        assert.ok(STRINGS[language][`error.${code}`], `error.${code} missing in ${language}`);
      }
      for (const code of mockCodes) {
        assert.ok(STRINGS[language][`mock.${code}`], `mock.${code} missing in ${language}`);
      }
    }
  });
});

describe('t()', () => {
  test('fills placeholders', () => {
    setLanguage('nl');
    assert.match(t('app.subtitle', { count: '1.234', range: 'afgelopen 30 dagen' }), /1\.234 bezoekers/);
  });

  test('returns the key itself when it is unknown, rather than a blank', () => {
    assert.equal(t('nope.not.a.key'), 'nope.not.a.key');
  });

  test('leaves a placeholder alone when no value is supplied', () => {
    assert.match(t('app.subtitle', {}), /\{count\}/);
  });

  test('switches language', () => {
    setLanguage('en');
    assert.equal(t('headline.weekly'), 'This week');
    setLanguage('nl');
    assert.equal(t('headline.weekly'), 'Deze week');
  });

  test('an unknown language falls back to Dutch rather than breaking', () => {
    setLanguage('de');
    assert.equal(t('headline.weekly'), 'Deze week');
  });
});

describe('translateCode()', () => {
  test('translates a code the client knows', () => {
    setLanguage('nl');
    assert.match(translateCode('error', 'RESOURCE_EXHAUSTED', {}, 'english fallback'), /limiet/);
  });

  test('interpolates the values the server sent', () => {
    setLanguage('nl');
    assert.match(translateCode('error', 'NOT_FOUND', { propertyId: '42' }, ''), /ID 42/);
  });

  test("uses the server's own message for a code this build does not know", () => {
    assert.equal(translateCode('error', 'SOMETHING_NEW', {}, 'a newer server said this'),
      'a newer server said this');
  });

  test('falls back to the generic message when there is nothing else', () => {
    setLanguage('nl');
    assert.equal(translateCode('error', 'SOMETHING_NEW', {}, ''), STRINGS.nl['error.UNKNOWN']);
  });
});
