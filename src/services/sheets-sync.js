'use strict';

const { google } = require('googleapis');

// ─────────────────────────────────────────────────────────────────────────────
// Google Sheets sync for the Operations Transaction tracker.
//
// Layout — 14 visible columns + 1 hidden id at A and 1 hidden mtime at N+1
// when initialized. Each transaction occupies one row. New rows insert at
// position FIRST_DATA_ROW (= 5), pushing older rows down. Rows 2-4 are
// "reserved" — the user can hand-write a manual entry there and the next
// poll will promote it (Phase 3).
//
// Columns:
//   A  id            (hidden — uses transaction.id UUID)
//   B  Data
//   C  Klient
//   D  Kwota
//   E  Zawartość     (full list as cell note on hover)
//   F  ☐ Order
//   G  ☐ FV
//   H  nr FV
//   I  ☐ Wysłano
//   J  nr GK
//   K  ☐ Dostarczono (data dostawy in cell note)
//   L  ☐ Płatność
//   M  Notatki
//   N  gs_modified   (hidden — ISO timestamp of last write from API)
//
// Auth: Service Account JSON in env GOOGLE_SERVICE_ACCOUNT_JSON, target
// spreadsheet in GOOGLE_SHEETS_SPREADSHEET_ID. Both must be set for any
// of the functions below to do anything; otherwise they no-op (so dev /
// CI environments don't blow up).
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const RESERVED_ROWS = 3;          // user manual-entry slots between header and data
const HEADER_ROW = 1;
const FIRST_DATA_ROW = HEADER_ROW + RESERVED_ROWS + 1;   // = 5
const NUM_COLS = 14;
const COL_RANGE = 'A:N';

const HEADERS = [
  'id',
  'Data',
  'Klient',
  'Kwota',
  'Zawartość',
  '☐ Order',
  '☐ FV',
  'nr FV',
  '☐ Wysłano',
  'nr GK',
  '☐ Dostarczono',
  '☐ Płatność',
  'Notatki',
  'gs_modified',
];

// Cached clients
let sheetsClient = null;
let defaultSheetGid = null;

function isConfigured() {
  return !!(SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

async function getClient() {
  if (sheetsClient) return sheetsClient;
  if (!isConfigured()) throw new Error('Google Sheets not configured (set GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_SHEETS_SPREADSHEET_ID)');
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: client });
  return sheetsClient;
}

async function getDefaultSheetGid() {
  if (defaultSheetGid != null) return defaultSheetGid;
  const sheets = await getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  defaultSheetGid = meta.data.sheets[0].properties.sheetId;
  return defaultSheetGid;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

function txToRow(tx) {
  const kwota = tx.amount != null
    ? `${Number(tx.amount).toFixed(2)} ${tx.currency || ''}`.trim()
    : '';
  return [
    tx.id || '',
    fmtDate(tx.occurredAt),
    tx.contractorName || '',
    kwota,
    tx.itemsSummary || '',
    tx.hasOrder ? 'TAK' : '',
    tx.hasInvoice ? 'TAK' : '',
    tx.invoiceNumber || '',
    tx.hasShipped ? 'TAK' : '',
    tx.shipmentNumber || '',
    tx.hasDelivered ? 'TAK' : '',
    tx.hasPayment ? 'TAK' : '',
    tx.notes || '',
    new Date().toISOString(),
  ];
}

function buildItemsNote(tx) {
  if (!tx.itemsDetails) return null;
  const items = Array.isArray(tx.itemsDetails) ? tx.itemsDetails : null;
  if (!items || items.length === 0) return null;
  return items.map(it => {
    const qty = it.qty != null ? `${it.qty}× ` : '';
    const name = it.name || it.ean || '?';
    const variant = it.variant ? ` ${it.variant}` : '';
    const price = it.priceNetto != null ? ` @ ${it.priceNetto}` : '';
    return `${qty}${name}${variant}${price}`;
  }).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialize the sheet — writes headers, formats the reserved rows visually,
// freezes the header row. Idempotent: safe to call multiple times.
// ─────────────────────────────────────────────────────────────────────────────
async function initSheet() {
  const sheets = await getClient();
  const gid = await getDefaultSheetGid();

  // 1. Write headers
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${COL_RANGE}${HEADER_ROW}`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });

  // 2. Mark reserved rows visually (yellow tint) + freeze header
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        // Freeze header
        {
          updateSheetProperties: {
            properties: { sheetId: gid, gridProperties: { frozenRowCount: HEADER_ROW } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        // Header bold
        {
          repeatCell: {
            range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: NUM_COLS },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
            fields: 'userEnteredFormat(textFormat,backgroundColor)',
          },
        },
        // Reserved rows visual marker (light yellow)
        {
          repeatCell: {
            range: { sheetId: gid, startRowIndex: 1, endRowIndex: 1 + RESERVED_ROWS, startColumnIndex: 0, endColumnIndex: NUM_COLS },
            cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.99, blue: 0.85 } } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        },
        // Hide column A (id)
        {
          updateDimensionProperties: {
            range: { sheetId: gid, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
            properties: { hiddenByUser: true },
            fields: 'hiddenByUser',
          },
        },
        // Hide column N (gs_modified)
        {
          updateDimensionProperties: {
            range: { sheetId: gid, dimension: 'COLUMNS', startIndex: 13, endIndex: 14 },
            properties: { hiddenByUser: true },
            fields: 'hiddenByUser',
          },
        },
      ],
    },
  });

  return { ok: true, headers: HEADERS, reservedRows: RESERVED_ROWS, firstDataRow: FIRST_DATA_ROW };
}

// ─────────────────────────────────────────────────────────────────────────────
// Insert a transaction at FIRST_DATA_ROW, pushing older rows down. Returns
// the new sheetRowId.
// ─────────────────────────────────────────────────────────────────────────────
async function insertTopRow(tx) {
  const sheets = await getClient();
  const gid = await getDefaultSheetGid();

  // 1. Make space — insert blank row at position FIRST_DATA_ROW
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        insertDimension: {
          range: { sheetId: gid, dimension: 'ROWS', startIndex: FIRST_DATA_ROW - 1, endIndex: FIRST_DATA_ROW },
          inheritFromBefore: false,
        },
      }],
    },
  });

  // 2. Write the row values
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${COL_RANGE}${FIRST_DATA_ROW}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [txToRow(tx)] },
  });

  // 3. Add cell note with full items detail on column E (Zawartość)
  const note = buildItemsNote(tx);
  if (note) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          updateCells: {
            range: { sheetId: gid, startRowIndex: FIRST_DATA_ROW - 1, endRowIndex: FIRST_DATA_ROW, startColumnIndex: 4, endColumnIndex: 5 },
            rows: [{ values: [{ note }] }],
            fields: 'note',
          },
        }],
      },
    });
  }

  return FIRST_DATA_ROW;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update an existing row in place (when transaction state changes — e.g.
// invoice was just confirmed, hasShipped flips to true after order goes
// through). Identifies the row by transaction.id in column A.
// ─────────────────────────────────────────────────────────────────────────────
async function updateRowById(tx) {
  if (!tx.sheetRowId) return null;   // nothing to update if not yet on the sheet
  const sheets = await getClient();

  // Verify the row still belongs to this transaction (rows shift around when
  // the user inserts manual entries or when we insert at top).
  const cell = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `A${tx.sheetRowId}`,
  });
  const idAtRow = cell.data.values && cell.data.values[0] && cell.data.values[0][0];
  if (idAtRow !== tx.id) {
    // Drift — row was moved or deleted. Caller should reposition.
    return { drifted: true, expectedId: tx.id, foundId: idAtRow };
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${COL_RANGE}${tx.sheetRowId}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [txToRow(tx)] },
  });

  const note = buildItemsNote(tx);
  if (note) {
    const gid = await getDefaultSheetGid();
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          updateCells: {
            range: { sheetId: gid, startRowIndex: tx.sheetRowId - 1, endRowIndex: tx.sheetRowId, startColumnIndex: 4, endColumnIndex: 5 },
            rows: [{ values: [{ note }] }],
            fields: 'note',
          },
        }],
      },
    });
  }

  return { drifted: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete a row when a transaction is removed (manual merge: secondary).
// ─────────────────────────────────────────────────────────────────────────────
async function deleteRowById(rowId) {
  if (!rowId) return null;
  const sheets = await getClient();
  const gid = await getDefaultSheetGid();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: gid, dimension: 'ROWS', startIndex: rowId - 1, endIndex: rowId },
        },
      }],
    },
  });
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read every data row from the sheet (skipping header + reserved). Returns
// {rowId, id, values[]}. Used by the inverse-direction sync (Phase 3) to
// detect manual user edits.
// ─────────────────────────────────────────────────────────────────────────────
async function readAllDataRows() {
  const sheets = await getClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${COL_RANGE}${FIRST_DATA_ROW}:${FIRST_DATA_ROW + 2000}`,
  });
  const values = resp.data.values || [];
  return values
    .map((row, idx) => ({
      rowId: FIRST_DATA_ROW + idx,
      id: row[0] || null,
      values: row,
    }))
    .filter(r => r.id);
}

module.exports = {
  isConfigured,
  initSheet,
  insertTopRow,
  updateRowById,
  deleteRowById,
  readAllDataRows,
  txToRow,
  HEADERS,
  RESERVED_ROWS,
  FIRST_DATA_ROW,
};
