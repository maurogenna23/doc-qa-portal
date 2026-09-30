import { LIMITS } from '@docqa/contracts';
import { describe, expect, it } from 'vitest';
import {
  extractText,
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
    ['.gitignore', ''],
    ['/a/b/report.pdf', '.pdf'],
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
    ['Refund Policy (2024).pdf', 'refund-policy-2024.pdf'],
    ['Refund Policy.pdf', 'refund-policy.pdf'],
    ['weird   spacing.txt', 'weird-spacing.txt'],
    ['UPPER_CASE_NAME.md', 'upper_case_name.md'],
    ['/Users/me/docs/nested file.txt', 'nested-file.txt'],
  ])('turns %s into %s', (name, expected) => {
    expect(deriveDocumentId(name)).toBe(expected);
  });

  it('gives the same stem in different formats different ids', () => {
    // Regression guard. Re-using an id replaces that document, which is right
    // when a person picks the id and destructive when an app derives it from a
    // file name: report.pdf today and report.docx tomorrow silently destroyed
    // the first. The extension is part of the id for exactly this reason.
    const ids = ['report.pdf', 'report.docx', 'report.md', 'report.txt'].map(deriveDocumentId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('still gives the same file the same id, so re-uploading it replaces it', () => {
    expect(deriveDocumentId('/a/b/report.pdf')).toBe(deriveDocumentId('/c/report.pdf'));
  });

  it('does not leave a separator stranded beside the extension', () => {
    expect(deriveDocumentId('Refund Policy (2024).pdf')).not.toContain('-.');
  });

  it('strips accents rather than dropping the words carrying them', () => {
    expect(deriveDocumentId('Poliza de Devolucion.docx')).toBe('poliza-de-devolucion.docx');
    expect(deriveDocumentId('Póliza de Devolución.docx')).toBe('poliza-de-devolucion.docx');
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

  it('treats a leading dot as a hidden file, not an extension', () => {
    // ".gitignore" is a name. Reading "gitignore" as its type would be wrong,
    // and would produce the id "gitignore.gitignore".
    expect(extensionOf('.gitignore')).toBe('');
    expect(deriveDocumentId('.gitignore')).toBe('gitignore');
  });

  it('falls back when nothing usable is left', () => {
    expect(deriveDocumentId('###.txt')).toBe('document.txt');
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

describe('extractText and mismatched contents', () => {
  /**
   * Dispatching on the extension alone was asymmetric: text renamed .pdf was
   * caught by the parser, a PDF renamed .txt was read as text and put twelve
   * thousand characters of binary into the index.
   */
  const asFile = (bytes: Uint8Array | string, name: string) =>
    new File([bytes as BlobPart], name);

  it('reads a genuine text file', async () => {
    await expect(extractText(asFile('Refunds take 30 days.', 'policy.txt'))).resolves.toBe(
      'Refunds take 30 days.',
    );
  });

  it('refuses a binary file renamed to .txt', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x33, 0x00, 0x01]);

    await expect(extractText(asFile(pdfBytes, 'lied.txt'))).rejects.toThrow(/binary, not text/);
  });

  it('refuses a file whose contents are not the PDF it claims to be', async () => {
    await expect(extractText(asFile('This is not a PDF at all.', 'lied.pdf'))).rejects.toThrow(
      /not a PDF/,
    );
  });

  it('refuses a file whose contents are not the DOCX it claims to be', async () => {
    await expect(extractText(asFile('Not a zip.', 'lied.docx'))).rejects.toThrow(/not a DOCX/);
  });

  it('refuses an unsupported extension by name, before reading anything', async () => {
    await expect(extractText(asFile('anything', 'notes.pages'))).rejects.toThrow(/not supported/);
  });

  it('refuses an empty text file rather than ingesting a blank document', async () => {
    await expect(extractText(asFile('   \n  ', 'blank.txt'))).rejects.toThrow(/no text/);
  });
});
