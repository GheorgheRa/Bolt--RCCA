import { read, utils, writeFile } from 'xlsx';
import { jsPDF } from 'jspdf';
import { pdfItemsToRows } from './pdfTable';

export const IMPORT_ACCEPT = '.pdf,.xlsx,.xls,.csv';

/** @param {string} title */
export const datedFileName = title =>
  `${title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${new Date().toISOString().slice(0, 10)}`;

// The built-in jsPDF fonts cannot render Romanian characters such as ș, ț or ă.
/** @param {unknown} text */
const pdfSafe = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {string[]} headers
 * @param {unknown[][]} rows
 * @param {string} filename without extension
 */
export function downloadCsv(headers, rows, filename) {
  const csv = utils.sheet_to_csv(utils.aoa_to_sheet([headers, ...rows]));
  downloadBlob(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`);
}

/**
 * @param {string} title
 * @param {string[]} headers
 * @param {unknown[][]} rows
 * @param {string} filename
 */
function downloadPdf(title, headers, rows, filename) {
  const doc = new jsPDF({ orientation: headers.length > 4 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const columnWidth = (pageWidth - margin * 2) / headers.length;
  const lineHeight = 16;
  let y = margin;

  const drawHeader = () => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    headers.forEach((header, index) => doc.text(pdfSafe(header), margin + index * columnWidth, y));
    doc.setLineWidth(0.5);
    doc.line(margin, y + 4, pageWidth - margin, y + 4);
    doc.setFont('helvetica', 'normal');
    y += lineHeight + 2;
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(pdfSafe(title), margin, y);
  y += 28;
  drawHeader();

  rows.forEach(row => {
    if (y > pageHeight - margin) {
      doc.addPage();
      y = margin;
      drawHeader();
    }
    row.forEach((cell, index) => {
      const text = doc.splitTextToSize(pdfSafe(cell), columnWidth - 8)[0] || '';
      doc.text(text, margin + index * columnWidth, y);
    });
    y += lineHeight;
  });

  doc.save(`${filename}.pdf`);
}

/**
 * @param {'pdf' | 'xlsx' | 'csv'} format
 * @param {{ title: string, headers: string[], rows: unknown[][], filename: string, sheetName: string }} table
 */
export function downloadTable(format, { title, headers, rows, filename, sheetName }) {
  if (format === 'pdf') return downloadPdf(title, headers, rows, filename);
  if (format === 'csv') return downloadCsv(headers, rows, filename);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([headers, ...rows]), sheetName);
  writeFile(workbook, `${filename}.xlsx`);
}

/** @param {File} file */
async function readPdfItems(file) {
  const pdfjs = await import('pdfjs-dist');
  // @ts-expect-error Vite resolves `?url` imports to the bundled asset URL.
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  /** @type {Array<{ str: string, x: number, y: number, page: number }>} */
  const items = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    content.items.forEach(item => {
      if ('str' in item) items.push({ str: item.str, x: item.transform[4], y: item.transform[5], page: pageNumber });
    });
  }
  await pdf.destroy();
  return items;
}

/**
 * Reads the first sheet of a CSV/Excel file, or the text table of a PDF, as an array of rows.
 * Everything happens in the browser; nothing is uploaded.
 *
 * @param {File} file
 * @param {(row: unknown[]) => boolean} isHeaderRow used to align PDF text to header columns
 * @returns {Promise<unknown[][]>}
 */
export async function readTableFile(file, isHeaderRow) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (!['csv', 'xlsx', 'xls', 'pdf'].includes(extension)) {
    throw new Error('Unsupported file type. Use PDF, Excel (.xlsx/.xls) or CSV.');
  }
  if (extension === 'pdf') return pdfItemsToRows(await readPdfItems(file), isHeaderRow);
  const workbook = extension === 'csv'
    ? read(await file.text(), { type: 'string', raw: true })
    : read(await file.arrayBuffer(), { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return sheet ? utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) : [];
}
