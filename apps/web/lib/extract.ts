import { LIMITS } from '@docqa/contracts';

/**
 * Turning uploaded files into the plain text the API ingests.
 *
 * Extraction happens in the browser rather than in a Lambda. The assignment
 * lists Tika alongside Textract as acceptable, and Tika extracts text without
 * OCR — so the bonus is about reading documents, not about reading images of
 * documents. Once OCR is out of scope, doing this client-side needs no upload
 * endpoint, no presigned URLs, no binary through API Gateway's payload limit,
 * no extra IAM and no per-page cost. The libraries load only when a file is
 * actually dropped.
 *
 * What it cannot do is read a scanned PDF, which carries images and no text
 * layer. That case is detected and reported rather than ingested as an empty
 * document.
 */

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx'] as const;

/** The `accept` attribute for the file input. */
export const ACCEPTED_FILE_TYPES = SUPPORTED_EXTENSIONS.join(',');

/** Refused before anything is parsed: a large binary would freeze the tab. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class FileExtractionError extends Error {
  constructor(
    readonly fileName: string,
    message: string,
  ) {
    super(message);
    this.name = 'FileExtractionError';
  }
}

export function extensionOf(fileName: string): string {
  const withoutPath = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = withoutPath.lastIndexOf('.');
  // A leading dot makes a hidden file, not an extension: ".gitignore" is a
  // name, and treating "gitignore" as its type would be wrong.
  return dot <= 0 ? '' : withoutPath.slice(dot).toLowerCase();
}

export function isSupported(fileName: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));
}

function baseName(fileName: string): string {
  const withoutPath = fileName.split(/[/\\]/).pop() ?? fileName;
  const extension = extensionOf(withoutPath);
  return extension === '' ? withoutPath : withoutPath.slice(0, -extension.length);
}

/** Reduces arbitrary text to the characters the API accepts in a document id. */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * A document id derived from the file name, including its extension.
 *
 * The API only accepts letters, digits and `. _ : -`, and reserves `#`, so a
 * file called "Refund Policy (2024).pdf" has to become something legal before
 * it is offered as an id. The user can always edit it.
 *
 * The extension is part of the id on purpose. Re-ingesting an id replaces that
 * document, which is right when a person chooses the id and dangerous when an
 * app derives it: dropping `report.pdf` today and `report.docx` tomorrow would
 * have destroyed the first with no warning. Including the extension keeps the
 * property that matters — the same file re-uploaded still replaces itself —
 * while two different files stop colliding just because they share a stem.
 */
export function deriveDocumentId(fileName: string): string {
  const stem = slugify(baseName(fileName));
  const extension = slugify(extensionOf(fileName));
  const name = stem.length > 0 ? stem : 'document';

  const id = extension.length > 0 ? `${name}.${extension}` : name;
  return id.slice(0, LIMITS.maxDocIdChars);
}

/**
 * A readable title from the file name: separators become spaces, words
 * capitalised.
 *
 * Leading dots are dropped. A dotfile keeps its whole name as its base name,
 * which is right for an id but produced titles like ".txt" — a heading that
 * starts with punctuation reads as a mistake.
 */
export function deriveTitle(fileName: string): string {
  const words = baseName(fileName)
    .replace(/^\.+/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const titled = words
    .split(' ')
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');

  return (titled.length > 0 ? titled : 'Untitled document').slice(0, LIMITS.maxTitleChars);
}

/**
 * Collapses the whitespace extractors leave behind.
 *
 * A PDF's text layer arrives as positioned fragments, so naive joining produces
 * ragged spacing and stray line breaks mid-sentence. Paragraph breaks are kept,
 * because the chunker splits on them.
 */
export function normaliseExtractedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  // The loading task owns the worker; releasing the document alone leaks it.
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });

  try {
    const document = await task.promise;
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();

      // Items are positioned fragments, not words. Joining them with a space
      // inserts one inside any word the layout happened to split — a real PDF
      // produced "purchas e is made". pdfjs already carries the spacing inside
      // each fragment and flags line ends, so concatenating and honouring
      // hasEOL reproduces the text as written.
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      pages.push(text);
    }

    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

async function extractDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value;
}

/** The first bytes a format must start with, when it has a recognisable signature. */
const FILE_SIGNATURES: Record<string, { bytes: readonly number[]; label: string }> = {
  '.pdf': { bytes: [0x25, 0x50, 0x44, 0x46], label: 'a PDF' }, // %PDF
  '.docx': { bytes: [0x50, 0x4b, 0x03, 0x04], label: 'a DOCX' }, // PK\x03\x04
};

/**
 * Checks the file actually is what its extension claims.
 *
 * Dispatching on the extension alone was asymmetric: text renamed `.pdf` was
 * caught by the parser, but a PDF renamed `.txt` sailed through `file.text()`
 * and put twelve thousand characters of binary into the index. The check runs
 * in both directions — a signature where the format has one, and a scan for
 * NUL bytes where it does not, since plain text never contains them.
 */
async function assertContentMatchesExtension(file: File, extension: string): Promise<void> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());

  const signature = FILE_SIGNATURES[extension];
  if (signature !== undefined) {
    const matches = signature.bytes.every((byte, index) => head[index] === byte);
    if (!matches) {
      throw new FileExtractionError(
        file.name,
        `The contents are not ${signature.label}, whatever the extension says.`,
      );
    }
    return;
  }

  if (head.includes(0)) {
    throw new FileExtractionError(
      file.name,
      'The contents are binary, not text, whatever the extension says.',
    );
  }
}

/** Reads a file and returns the plain text to ingest. */
export async function extractText(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) {
    throw new FileExtractionError(
      file.name,
      `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
    );
  }

  const extension = extensionOf(file.name);
  if (!isSupported(file.name)) {
    throw new FileExtractionError(
      file.name,
      `${extension === '' ? 'Files without an extension' : `${extension} files`} are not supported. Use ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    );
  }

  await assertContentMatchesExtension(file, extension);

  let raw: string;
  try {
    if (extension === '.pdf') raw = await extractPdf(file);
    else if (extension === '.docx') raw = await extractDocx(file);
    else raw = await file.text();
  } catch (error) {
    throw new FileExtractionError(
      file.name,
      `Could not read the file: ${error instanceof Error ? error.message : 'unknown error'}.`,
    );
  }

  const text = normaliseExtractedText(raw);

  if (text.length === 0) {
    throw new FileExtractionError(
      file.name,
      extension === '.pdf'
        ? 'No text found. This looks like a scanned PDF — the pages are images, and reading those needs OCR, which this app does not do.'
        : 'The file contains no text.',
    );
  }

  if (text.length > LIMITS.maxContentChars) {
    throw new FileExtractionError(
      file.name,
      `Extracted ${text.length.toLocaleString()} characters; the limit is ${LIMITS.maxContentChars.toLocaleString()}. Split the document and add the parts separately.`,
    );
  }

  return text;
}
