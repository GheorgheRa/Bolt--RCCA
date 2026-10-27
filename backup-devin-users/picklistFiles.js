export const TWO_FIELD_CONFIG = {
  'Part Number vs Alias_Picklist': { primary: 'Part Number', secondary: 'Alias (optional)', hasClient: true },
  'Utilaj - Serial#_Picklist': { primary: 'Utilaj', secondary: 'Serial# (optional)', hasClient: false },
};

export const CLIENT_OPTIONS = ['HW', 'COL', 'PW', 'EVK', 'PK', 'AEC'];

export const MAX_IMPORT_ROWS = 2000;

/** @param {string} category */
export const isTwoFieldCategory = category => category in TWO_FIELD_CONFIG;

/** @param {string} category */
export const isThreeFieldCategory = category => TWO_FIELD_CONFIG[category]?.hasClient === true;

/** @param {string} label */
export const slugifyLabel = label => label.trim().toLowerCase().replace(/\s+/g, '_');

/** @param {unknown} text */
const normalizeHeader = text => String(text ?? '').toLowerCase().replace(/\(optional\)/g, '').replace(/[^a-z0-9#]/g, '');

/** @param {unknown} cell */
const cellText = cell => String(cell ?? '').replace(/\s+/g, ' ').trim();

const HEADER_ALIASES = {
  value: ['value', 'valoare', 'partnumber', 'partno', 'pn', 'utilaj', 'equipment', 'machine'],
  label: ['label', 'eticheta', 'name', 'nume', 'denumire', 'description', 'descriere', 'option', 'optiune', 'alias', 'serial', 'serial#', 'serialnumber', 'serialno'],
  client: ['client', 'customer'],
  active: ['active', 'activ', 'isactive', 'status'],
};

/**
 * @param {string} category
 * @returns {string[]}
 */
export function exportHeaders(category) {
  const config = TWO_FIELD_CONFIG[category];
  if (!config) return ['Label', 'Value', 'Active'];
  const headers = [config.primary, config.secondary.replace(/\s*\(optional\)/, '')];
  if (config.hasClient) headers.push('Client');
  headers.push('Active');
  return headers;
}

/**
 * @param {string} category
 * @param {Array<Record<string, any>>} options
 * @returns {string[][]}
 */
export function buildExportRows(category, options) {
  const sorted = [...options].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  return sorted.map(option => {
    const active = option.is_active === false ? 'No' : 'Yes';
    if (!isTwoFieldCategory(category)) return [option.label || '', option.value || '', active];
    const row = [option.value || '', option.label || ''];
    if (isThreeFieldCategory(category)) row.push(option.client || '');
    row.push(active);
    return row;
  });
}

/**
 * @param {unknown[]} row
 * @returns {Record<string, number> | null}
 */
function detectColumns(row) {
  /** @type {Record<string, number>} */
  const columns = {};
  row.forEach((cell, index) => {
    const header = normalizeHeader(cell);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (!(field in columns) && aliases.includes(header)) {
        columns[field] = index;
        return;
      }
    }
  });
  return 'value' in columns || 'label' in columns ? columns : null;
}

/** @param {string} text */
function parseActive(text) {
  return !['no', 'nu', 'false', '0', 'inactive', 'inactiv'].includes(text.toLowerCase());
}

/**
 * Converts a parsed table (array of rows) into new PicklistOption payloads for a category.
 * A header row is used when it is recognised; otherwise columns are taken positionally:
 * two-field categories use [primary, secondary, client], others use [label, value].
 *
 * @param {unknown[][]} table
 * @param {string} category
 * @param {Array<Record<string, any>>} existingOptions options already stored for this category
 */
export function rowsToPicklistOptions(table, category, existingOptions) {
  const rows = table.filter(row => Array.isArray(row) && row.some(cell => cellText(cell)));
  const twoField = isTwoFieldCategory(category);
  const hasClient = isThreeFieldCategory(category);

  let columns = null;
  let headerIndex = -1;
  for (let index = 0; index < Math.min(rows.length, 5); index += 1) {
    columns = detectColumns(rows[index]);
    if (columns) {
      headerIndex = index;
      break;
    }
  }
  if (columns && !twoField && !('label' in columns)) {
    const firstOther = rows[headerIndex].findIndex((_, index) => !Object.values(columns).includes(index));
    if (firstOther >= 0) columns.label = firstOther;
  }
  if (!columns) {
    columns = twoField ? { value: 0, label: 1, ...(hasClient ? { client: 2 } : {}) } : { label: 0, value: 1 };
  }
  const dataRows = rows.slice(headerIndex + 1);

  const seen = new Set(existingOptions.map(option => String(option.value ?? '').trim().toLowerCase()));
  let maxOrder = existingOptions.reduce((max, option) => Math.max(max, Number(option.sort_order) || 0), 0);
  const toCreate = [];
  let duplicates = 0;
  let invalid = 0;
  let unknownClients = 0;

  for (const row of dataRows) {
    /** @param {string} field */
    const get = field => (field in columns ? cellText(row[columns[field]]) : '');
    let label = get('label');
    let value = get('value');

    if (twoField) {
      if (!value) {
        invalid += 1;
        continue;
      }
    } else {
      if (!label) label = value;
      if (!label) {
        invalid += 1;
        continue;
      }
      value = value || slugifyLabel(label);
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    maxOrder += 1;
    /** @type {Record<string, any>} */
    const payload = {
      category,
      label,
      value,
      sort_order: maxOrder,
      is_active: 'active' in columns ? parseActive(get('active')) : true,
    };
    if (hasClient) {
      const client = get('client').toUpperCase();
      if (client && !CLIENT_OPTIONS.includes(client)) unknownClients += 1;
      payload.client = CLIENT_OPTIONS.includes(client) ? client : null;
    }
    toCreate.push(payload);
  }

  return { toCreate, duplicates, invalid, unknownClients, headerDetected: headerIndex >= 0 };
}

/**
 * Groups positioned PDF text items into table rows. Items on the same line (similar y) become
 * one row; when a header line is recognised, cells are assigned to the nearest header column.
 *
 * @param {Array<{ str: string, x: number, y: number, page: number }>} items
 * @returns {string[][]}
 */
export function pdfItemsToRows(items) {
  /** @type {Array<{ page: number, y: number, cells: Array<{ x: number, text: string }> }>} */
  const lines = [];
  const sorted = items
    .filter(item => item.str.trim())
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  for (const item of sorted) {
    const line = lines.find(candidate => candidate.page === item.page && Math.abs(candidate.y - item.y) <= 2.5);
    const cell = { x: item.x, text: item.str.trim() };
    if (line) line.cells.push(cell);
    else lines.push({ page: item.page, y: item.y, cells: [cell] });
  }
  lines.forEach(line => line.cells.sort((a, b) => a.x - b.x));

  const headerLine = lines.find(line => detectColumns(line.cells.map(cell => cell.text)));
  if (!headerLine) return lines.map(line => line.cells.map(cell => cell.text));

  const headerTexts = headerLine.cells.map(cell => normalizeHeader(cell.text));
  const columnStarts = headerLine.cells.map(cell => cell.x);
  /** @type {string[][]} */
  const rows = [headerLine.cells.map(cell => cell.text)];
  for (const line of lines) {
    if (line === headerLine) continue;
    const texts = line.cells.map(cell => normalizeHeader(cell.text));
    if (texts.length === headerTexts.length && texts.every((text, index) => text === headerTexts[index])) continue;
    if (line.page === headerLine.page && line.y > headerLine.y) continue;
    /** @type {string[]} */
    const row = columnStarts.map(() => '');
    for (const cell of line.cells) {
      let column = 0;
      columnStarts.forEach((start, index) => {
        if (cell.x >= start - 4) column = index;
      });
      row[column] = row[column] ? `${row[column]} ${cell.text}` : cell.text;
    }
    rows.push(row);
  }
  return rows;
}
