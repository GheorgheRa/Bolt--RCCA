/** @param {string} text */
const normalizeHeader = text => text.toLowerCase().replace(/[^a-z0-9#]/g, '');

/**
 * Groups positioned PDF text items into table rows. Items on the same line (similar y) become
 * one row; when a header line is recognised, cells are assigned to the nearest header column.
 *
 * @param {Array<{ str: string, x: number, y: number, page: number }>} items
 * @param {(cells: string[]) => boolean} isHeaderRow
 * @returns {string[][]}
 */
export function pdfItemsToRows(items, isHeaderRow) {
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

  const headerLine = lines.find(line => isHeaderRow(line.cells.map(cell => cell.text)));
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
