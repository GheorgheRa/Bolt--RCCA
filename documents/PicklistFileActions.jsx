import React, { useRef, useState } from 'react';
import { appApi } from '@/api/appClient';
import { Button } from '@/components/ui/button';
import { Download, Upload, Loader2 } from 'lucide-react';
import { IMPORT_ACCEPT, datedFileName, downloadTable, readTableFile } from '@/components/shared/tableFiles';
import {
  MAX_IMPORT_ROWS,
  buildExportRows,
  exportHeaders,
  isPicklistHeaderRow,
  rowsToPicklistOptions,
} from './picklistFiles';

const STATUS_COLORS = { success: 'text-green-600', warning: 'text-amber-600', error: 'text-red-600' };

export default function PicklistFileActions({ category, categoryLabel, options, onImported }) {
  const fileInputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState(null);

  const handleExport = (format) => {
    downloadTable(format, {
      title: `Picklist: ${categoryLabel}`,
      headers: exportHeaders(category),
      rows: buildExportRows(category, options),
      filename: datedFileName(`picklist ${categoryLabel}`),
      sheetName: 'Picklist',
    });
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImporting(true);
    setStatus(null);
    try {
      const table = await readTableFile(file, isPicklistHeaderRow);
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
        <input ref={fileInputRef} type="file" accept={IMPORT_ACCEPT} className="hidden" onChange={handleImport} />
      </div>
      {status && <p className={`text-xs ${STATUS_COLORS[status.type]}`}>{status.text}</p>}
    </div>
  );
}
