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
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

export function isSupported(fileName: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));
}

function baseName(fileName: string): string {
  const withoutPath = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = withoutPath.lastIndexOf('.');
  return dot <= 0 ? withoutPath : withoutPath.slice(0, dot);
}

/**
 * A document id derived from the file name.
 *
 * The API only accepts letters, digits and `. _ : -`, and reserves `#`, so a
 * file called "Refund Policy (2024).pdf" has to become something legal before
 * it is offered as an id. The user can always edit it.
 */
export function deriveDocumentId(fileName: string): string {
  const slug = baseName(fileName)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, LIMITS.maxDocIdChars);

  return slug.length > 0 ? slug : 'document';
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
