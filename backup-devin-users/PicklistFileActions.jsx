import React, { useRef, useState } from 'react';
import { read, utils, writeFile } from 'xlsx';
import { jsPDF } from 'jspdf';
import { appApi } from '@/api/appClient';
import { Button } from '@/components/ui/button';
import { Download, Upload, Loader2 } from 'lucide-react';
import {
  MAX_IMPORT_ROWS,
  buildExportRows,
  exportHeaders,
  pdfItemsToRows,
  rowsToPicklistOptions,
} from './picklistFiles';

const STATUS_COLORS = { success: 'text-green-600', warning: 'text-amber-600', error: 'text-red-600' };

const fileBaseName = (categoryLabel) =>
  `picklist_${categoryLabel.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${new Date().toISOString().slice(0, 10)}`;

// The built-in jsPDF fonts cannot render Romanian characters such as ș, ț or ă.
const pdfSafe = (text) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPdf(title, headers, rows, filename) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
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

async function readPdfRows(file) {
  const pdfjs = await import('pdfjs-dist');
  // @ts-expect-error Vite resolves `?url` imports to the bundled asset URL.
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const items = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    content.items.forEach(item => {
      if ('str' in item) items.push({ str: item.str, x: item.transform[4], y: item.transform[5], page: pageNumber });
    });
  }
  await pdf.destroy();
  return pdfItemsToRows(items);
}

async function readSpreadsheetRows(file, isCsv) {
  const workbook = isCsv
    ? read(await file.text(), { type: 'string', raw: true })
    : read(await file.arrayBuffer(), { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return sheet ? utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) : [];
}

export default function PicklistFileActions({ category, categoryLabel, options, onImported }) {
  const fileInputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState(null);

  const handleExport = (format) => {
    const headers = exportHeaders(category);
    const rows = buildExportRows(category, options);
    const filename = fileBaseName(categoryLabel);
    if (format === 'pdf') {
      exportPdf(`Picklist: ${categoryLabel}`, headers, rows, filename);
      return;
    }
    const sheet = utils.aoa_to_sheet([headers, ...rows]);
    if (format === 'csv') {
      downloadBlob(new Blob([`\ufeff${utils.sheet_to_csv(sheet)}`], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`);
      return;
    }
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, 'Picklist');
    writeFile(workbook, `${filename}.xlsx`);
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx', 'xls', 'pdf'].includes(extension)) {
      setStatus({ type: 'error', text: 'Unsupported file type. Use PDF, Excel (.xlsx/.xls) or CSV.' });
      return;
    }

    setImporting(true);
    setStatus(null);
    try {
      const table = extension === 'pdf' ? await readPdfRows(file) : await readSpreadsheetRows(file, extension === 'csv');
      const result = rowsToPicklistOptions(table, category, options);
      if (result.toCreate.length > MAX_IMPORT_ROWS) {
        setStatus({ type: 'error', text: `The file has ${result.toCreate.length} new rows; the limit is ${MAX_IMPORT_ROWS} per import.` });
        return;
      }
      const created = result.toCreate.length ? await appApi.entities.PicklistOption.bulkCreate(result.toCreate) : [];
      onImported(created);

      const details = [];
      if (result.duplicates) details.push(`${result.duplicates} already existed`);
      if (result.invalid) details.push(`${result.invalid} empty/invalid`);
      if (result.unknownClients) details.push(`${result.unknownClients} with unknown client (left empty)`);
      const summary = `Imported ${created.length} option${created.length === 1 ? '' : 's'} into ${categoryLabel}`;
      if (created.length) setStatus({ type: 'success', text: details.length ? `${summary} (${details.join(', ')}).` : `${summary}.` });
      else setStatus({ type: 'warning', text: details.length ? `Nothing new to import (${details.join(', ')}).` : 'No rows found in the file.' });
    } catch (error) {
      setStatus({ type: 'error', text: `Import failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-1.5">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-500">Export:</span>
      {[['pdf', 'PDF'], ['xlsx', 'Excel'], ['csv', 'CSV']].map(([format, label]) => (
        <Button key={format} size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleExport(format)} disabled={!options.length}>
          <Download className="w-3.5 h-3.5" />
          {label}
        </Button>
      ))}
      <Button size="sm" variant="outline" className="h-7 text-xs ml-auto" onClick={() => fileInputRef.current?.click()} disabled={importing}>
        {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
        Import (PDF / Excel / CSV)
      </Button>
      <input ref={fileInputRef} type="file" accept=".pdf,.xlsx,.xls,.csv" className="hidden" onChange={handleImport} />
    </div>
    {status && <p className={`text-xs ${STATUS_COLORS[status.type]}`}>{status.text}</p>}
    </div>
  );
}
