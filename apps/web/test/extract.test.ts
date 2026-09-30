import { LIMITS } from '@docqa/contracts';
import { describe, expect, it } from 'vitest';
import {
  deriveDocumentId,
  deriveTitle,
  extensionOf,
  isSupported,
  normaliseExtractedText,
} from '../lib/extract';

/**
 * The parsing and normalisation here is pure, so it is tested directly. The PDF
 * and DOCX readers are thin wrappers over pdfjs and mammoth and are exercised
 * in the browser instead: mocking them would test the mock.
 */

/** Avoids writing control characters into a regex literal in this file. */
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
  });
}

describe('extensionOf', () => {
  it.each([
    ['refund.pdf', '.pdf'],
    ['Refund.PDF', '.pdf'],
    ['report.final.docx', '.docx'],
    ['README', ''],
  ])('reads %s as %s', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });
});

describe('isSupported', () => {
  it.each(['a.txt', 'a.md', 'a.pdf', 'a.docx', 'A.PDF'])('accepts %s', (name) => {
    expect(isSupported(name)).toBe(true);
  });

  it.each(['a.doc', 'a.pages', 'a.png', 'a.zip', 'noextension'])('rejects %s', (name) => {
    // .doc is the pre-2007 binary format, which mammoth does not read. Saying
    // so up front beats failing after the file has been read.
    expect(isSupported(name)).toBe(false);
  });
});

describe('deriveDocumentId', () => {
  it.each([
    ['Refund Policy (2024).pdf', 'refund-policy-2024'],
    ['Refund Policy.pdf', 'refund-policy'],
    ['weird   spacing.txt', 'weird-spacing'],
    ['UPPER_CASE_NAME.md', 'upper_case_name'],
    ['/Users/me/docs/nested file.txt', 'nested-file'],
  ])('turns %s into %s', (name, expected) => {
    expect(deriveDocumentId(name)).toBe(expected);
  });

  it('strips accents rather than dropping the words carrying them', () => {
    expect(deriveDocumentId('Poliza de Devolucion.docx')).toBe('poliza-de-devolucion');
    expect(deriveDocumentId('Póliza de Devolución.docx')).toBe('poliza-de-devolucion');
  });

  it('never produces an id containing the reserved chunk separator', () => {
    expect(deriveDocumentId('a#b#c.txt')).not.toContain('#');
  });

  it.each(['###.txt', '.txt', '.gitignore', '   .txt', '...'])(
    'never produces an empty or illegal id for %s',
    (name) => {
      const id = deriveDocumentId(name);

      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(/^[A-Za-z0-9._:-]+$/);
    },
  );

  it('keeps a dotfile name rather than discarding it', () => {
    // The whole name is the base name for a dotfile, which is what makes
    // ".gitignore" an id at all.
    expect(deriveDocumentId('.gitignore')).toBe('gitignore');
  });

  it('falls back when nothing usable is left', () => {
    expect(deriveDocumentId('###.txt')).toBe('document');
  });

  it('respects the id length limit', () => {
    expect(deriveDocumentId(`${'x'.repeat(400)}.txt`).length).toBeLessThanOrEqual(
      LIMITS.maxDocIdChars,
    );
  });

  it('produces ids the API pattern accepts', () => {
    const pattern = /^[A-Za-z0-9._:-]+$/;
    for (const name of ['Refund Policy.pdf', 'a b c.md', 'Ünïcødé.docx', '2024 report.txt']) {
      expect(deriveDocumentId(name)).toMatch(pattern);
    }
  });
});

describe('deriveTitle', () => {
  it.each([
    ['refund-policy.pdf', 'Refund Policy'],
    ['employee_handbook.docx', 'Employee Handbook'],
    ['notes.txt', 'Notes'],
  ])('turns %s into %s', (name, expected) => {
    expect(deriveTitle(name)).toBe(expected);
  });

  it('does not start a title with punctuation', () => {
    expect(deriveTitle('.gitignore')).toBe('Gitignore');
    expect(deriveTitle('.md')).toBe('Md');
  });

  it('never returns an empty title', () => {
    expect(deriveTitle('   .txt')).toBe('Untitled document');
    expect(deriveTitle('...')).toBe('Untitled document');
  });

  it('respects the title length limit', () => {
    expect(deriveTitle(`${'x'.repeat(400)}.txt`).length).toBeLessThanOrEqual(LIMITS.maxTitleChars);
  });

  it('never contains a control character, which the API rejects', () => {
    // A file name can legally carry a newline on most filesystems.
    expect(hasControlCharacter(deriveTitle('line\nbreak.txt'))).toBe(false);
  });
});

describe('normaliseExtractedText', () => {
  it('collapses the ragged spacing a PDF text layer produces', () => {
    expect(normaliseExtractedText('Full   refund    within  30 days.')).toBe(
      'Full refund within 30 days.',
    );
  });

  it('keeps paragraph breaks, because the chunker splits on them', () => {
    expect(normaliseExtractedText('First para.\n\n\n\nSecond para.')).toBe(
      'First para.\n\nSecond para.',
    );
  });

  it('normalises Windows line endings', () => {
    expect(normaliseExtractedText('a\r\n\r\nb')).toBe('a\n\nb');
  });

  it('returns an empty string for whitespace only, which callers treat as no text', () => {
    expect(normaliseExtractedText('   \n\n \t ')).toBe('');
  });
});
