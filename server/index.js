import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadsDirectory = path.join(dataDirectory, 'uploads');
const port = Number(process.env.PORT || 3001);
const sessionLifetimeSeconds = 60 * 60 * 24 * 7;
const allowedEntities = new Set([
  'AiLearnedLessons',
  'AiPromptConfig',
  'Document',
  'InspectionStandard',
  'IssueArchive',
  'PicklistOption',
  'ProductionBatch',
  'ProductionIssue',
  'StandupMeeting',
  'StandupPoint',
  'VisualInspectionEntry',
  'User',
]);
const allowedUploadTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/msword', '.doc'],
  ['application/vnd.ms-excel', '.xls'],
]);
const loginFailures = new Map();
const loginWindowMs = 15 * 60 * 1000;
const maxLoginFailures = 10;

await mkdir(dataDirectory, { recursive: true });
await mkdir(uploadsDirectory, { recursive: true });
const database = new DatabaseSync(path.join(dataDirectory, 'rcca.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    display_name TEXT,
    page_permissions TEXT,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    entity TEXT NOT NULL,
    data TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_date TEXT NOT NULL,
    updated_date TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS records_entity_created_idx ON records(entity, created_date);
  CREATE TABLE IF NOT EXISTS scheduled_runs (
    name TEXT NOT NULL,
    run_date TEXT NOT NULL,
    PRIMARY KEY (name, run_date)
  );
`);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function transaction(callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const [salt, expectedHex] = String(encoded || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(hashPassword(password, salt).split(':')[1], 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    display_name: row.display_name || null,
    page_permissions: row.page_permissions || null,
    created_date: row.created_at,
    created_by: row.email,
  };
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie || '';
  const item = cookies.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}

function sessionCookie(token, maxAge = sessionLifetimeSeconds) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `rcca_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function currentUser(request) {
  const token = cookieValue(request, 'rcca_session');
  if (!token) return null;
  const row = database.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashToken(token), new Date().toISOString());
  return row || null;
}

function requireUser(request) {
  const user = currentUser(request);
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  return user;
}

function requireAdmin(user) {
  if (user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
}

function createSession(response, user) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000).toISOString();
  database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), user.id, expiresAt);
  response.setHeader('Set-Cookie', sessionCookie(token));
}

function loginKey(request) {
  return request.socket.remoteAddress || 'unknown';
}

function checkLoginAttempts(request) {
  const key = loginKey(request);
  const attempts = loginFailures.get(key);
  if (!attempts) return;
  if (Date.now() - attempts.startedAt >= loginWindowMs) {
    loginFailures.delete(key);
    return;
  }
  if (attempts.count >= maxLoginFailures) {
    throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
  }
}

function recordLoginFailure(request) {
  const key = loginKey(request);
  const now = Date.now();
  const attempts = loginFailures.get(key);
  if (!attempts || now - attempts.startedAt >= loginWindowMs) {
    loginFailures.set(key, { count: 1, startedAt: now });
  } else {
    attempts.count += 1;
  }
  if (loginFailures.size > 10000) {
    for (const [address, state] of loginFailures) {
      if (now - state.startedAt >= loginWindowMs) loginFailures.delete(address);
      if (loginFailures.size <= 9000) break;
    }
  }
}

function clearSession(request, response) {
  const token = cookieValue(request, 'rcca_session');
  if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  response.setHeader('Set-Cookie', sessionCookie('', 0));
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  response.end(JSON.stringify(body));
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function createUser({ email, full_name, password, role = 'user' }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const name = String(full_name || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  if (!name) throw new HttpError(400, 'Name is required.');
  if (typeof password !== 'string' || password.length < 12) {
    throw new HttpError(400, 'Passwords must be at least 12 characters long.');
  }
  if (!['admin', 'user'].includes(role)) throw new HttpError(400, 'Invalid user role.');

  const user = {
    id: randomUUID(),
    email: normalizedEmail,
    full_name: name,
    role,
    display_name: null,
    page_permissions: null,
    created_at: new Date().toISOString(),
    password_hash: hashPassword(password),
  };
  try {
    database.prepare(`
      INSERT INTO users (id, email, full_name, role, display_name, page_permissions, password_hash, created_at)
      VALUES (@id, @email, @full_name, @role, @display_name, @page_permissions, @password_hash, @created_at)
    `).run(user);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      throw new HttpError(409, 'An account with this email already exists.');
    }
    throw error;
  }
  return user;
}

const bootstrapEmail = process.env.ADMIN_EMAIL;
const bootstrapPassword = process.env.ADMIN_PASSWORD;
if (Boolean(bootstrapEmail) !== Boolean(bootstrapPassword)) {
  throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD, or leave both unset.');
}
if (bootstrapEmail && !database.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  createUser({
    email: bootstrapEmail,
    full_name: process.env.ADMIN_NAME || 'Administrator',
    password: bootstrapPassword,
    role: 'admin',
  });
  console.info(`Created the initial administrator account: ${bootstrapEmail}`);
}

function parseQueryValue(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new HttpError(400, `Invalid ${name} query parameter.`);
  }
}

function matchesFilter(record, filter) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    const actual = record[key];
    if (Array.isArray(expected)) return expected.includes(actual);
    return actual === expected;
  });
}

function sortRecords(records, sort) {
  if (!sort) return records;
  const descending = sort.startsWith('-');
  const key = descending ? sort.slice(1) : sort;
  return records.sort((left, right) => {
    const a = left[key] ?? '';
    const b = right[key] ?? '';
    const comparison = typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true });
    return descending ? -comparison : comparison;
  });
}

function listUsers(filter, sort, limit) {
  const users = database.prepare('SELECT * FROM users').all().map(publicUser).filter(user => matchesFilter(user, filter));
  sortRecords(users, sort);
  return users.slice(0, limit);
}

function getRecord(entity, id) {
  const row = database.prepare('SELECT * FROM records WHERE entity = ? AND id = ?').get(entity, id);
  return row ? { ...JSON.parse(row.data), id: row.id, created_by: row.created_by, created_date: row.created_date, updated_date: row.updated_date } : null;
}

function listRecords(entity, filter, sort, limit) {
  if (entity === 'User') return listUsers(filter, sort, limit);
  const records = database.prepare('SELECT * FROM records WHERE entity = ?').all(entity).map(row => ({
    ...JSON.parse(row.data),
    id: row.id,
    created_by: row.created_by,
    created_date: row.created_date,
    updated_date: row.updated_date,
  })).filter(record => matchesFilter(record, filter));
  sortRecords(records, sort);
  return records.slice(0, limit);
}

function assertEntityWriteAccess(entity, user, record = null) {
  if (entity === 'User' || entity === 'PicklistOption' || entity === 'InspectionStandard') {
    requireAdmin(user);
    return;
  }
  if (record && ['ProductionIssue', 'Document'].includes(entity) && record.created_by !== user.email && user.role !== 'admin') {
    throw new HttpError(403, 'You can only edit records you created.');
  }
}

function createRecord(entity, payload, user) {
  assertEntityWriteAccess(entity, user);
  if (entity === 'User') {
    const account = createUser(payload);
    return publicUser(account);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'Record data must be an object.');
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO records (id, entity, data, created_by, created_date, updated_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, entity, JSON.stringify(payload), user.email, now, now);
  return { ...payload, id, created_by: user.email, created_date: now, updated_date: now };
}

function updateRecord(entity, id, updates, user, allowOwnerOverride = false) {
  if (entity === 'User') {
    requireAdmin(user);
    const target = database.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'User not found.');
    const patch = {};
    for (const field of ['full_name', 'display_name', 'page_permissions', 'role']) {
      if (Object.hasOwn(updates, field)) patch[field] = updates[field];
    }
    if (patch.role && !['admin', 'user'].includes(patch.role)) throw new HttpError(400, 'Invalid user role.');
    if (target.role === 'admin' && patch.role === 'user') {
      const adminCount = database.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin'").get().count;
      if (adminCount <= 1) throw new HttpError(409, 'The last administrator cannot be demoted.');
    }
    const fields = Object.keys(patch);
    if (fields.length) {
      database.prepare(`UPDATE users SET ${fields.map(field => `${field} = @${field}`).join(', ')} WHERE id = @id`)
        .run({ ...patch, id });
    }
    return publicUser(database.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }
  const existing = getRecord(entity, id);
  if (!existing) throw new HttpError(404, 'Record not found.');
  if (!allowOwnerOverride) assertEntityWriteAccess(entity, user, existing);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new HttpError(400, 'Record updates must be an object.');
  }
  const { id: _id, created_by: _createdBy, created_date: _createdDate, ...safeUpdates } = updates;
  const data = { ...existing };
  delete data.id;
  delete data.created_by;
  delete data.created_date;
  delete data.updated_date;
  const updated = { ...data, ...safeUpdates };
  const now = new Date().toISOString();
  database.prepare('UPDATE records SET data = ?, updated_date = ? WHERE entity = ? AND id = ?')
    .run(JSON.stringify(updated), now, entity, id);
  return { ...updated, id, created_by: existing.created_by, created_date: existing.created_date, updated_date: now };
}

function deleteRecord(entity, id, user) {
  if (entity === 'User') {
    requireAdmin(user);
    const target = database.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'admin') {
      const adminCount = database.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin'").get().count;
      if (adminCount <= 1) throw new HttpError(409, 'The last administrator cannot be deleted.');
    }
    database.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { id };
  }
  requireAdmin(user);
  const result = database.prepare('DELETE FROM records WHERE entity = ? AND id = ?').run(entity, id);
  if (!result.changes) throw new HttpError(404, 'Record not found.');
  return { id };
}

async function sendEmail(message) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new HttpError(503, 'Email is not configured. Set RESEND_API_KEY and EMAIL_FROM on the server.');
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: Array.isArray(message.to) ? message.to : [message.to],
      subject: message.subject,
      ...(String(message.body || '').includes('<') ? { html: message.body } : { text: message.body || '' }),
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new HttpError(502, `Email delivery failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json();
}

function localUploadPath(fileUrl) {
  if (typeof fileUrl !== 'string') return null;
  const match = /^\/uploads\/([a-f0-9-]+\.[a-z0-9]+)$/i.exec(fileUrl);
  return match ? path.join(uploadsDirectory, match[1]) : null;
}

async function invokeLlm(input) {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!apiKey) throw new HttpError(503, 'AI is not configured. Set AI_API_KEY on the server.');

  const content = [{ type: 'text', text: String(input.prompt || '') }];
  for (const fileUrl of input.file_urls || []) {
    const filePath = localUploadPath(fileUrl);
    if (!filePath) throw new HttpError(400, 'AI analysis only accepts files uploaded to this server.');
    const bytes = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[extension];
    if (!mimeType) throw new HttpError(400, 'Only supported image uploads can be analyzed by AI.');
    content.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${bytes.toString('base64')}` } });
  }
  const requestBody = {
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    messages: [{ role: 'user', content: content.length === 1 ? content[0].text : content }],
    ...(input.response_json_schema ? {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'response', strict: false, schema: input.response_json_schema },
      },
    } : {}),
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(502, result.error?.message || `AI provider returned ${response.status}.`);
  }
  const text = result.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new HttpError(502, 'AI provider returned an empty response.');
  if (!input.response_json_schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, 'AI provider did not return valid JSON.');
  }
}

async function runFunction(name, input, user) {
  if (name === 'getUsers') {
    const full = listUsers({}, 'full_name', 500);
    return {
      users: full.map(account => ({
        value: account.display_name || account.full_name || account.email,
        label: account.display_name || account.full_name || account.email,
        email: account.email,
      })).filter(account => account.value),
      full,
    };
  }
  if (name === 'saveOwnerFeedback') {
    const issue = getRecord('ProductionIssue', input.issue_id);
    if (!issue) throw new HttpError(404, 'Issue not found.');
    let actions;
    try {
      actions = JSON.parse(issue.corrective_actions_json || '[]');
    } catch {
      throw new HttpError(422, 'The issue contains invalid corrective-action data.');
    }
    if (!Array.isArray(input.actions)) throw new HttpError(400, 'Actions must be an array.');
    const account = publicUser(user);
    const displayName = account.display_name || account.full_name || account.email;
    const isOwner = actions.some(action => action.owner === displayName);
    if (!isOwner && user.role !== 'admin') throw new HttpError(403, 'You do not own a corrective action on this issue.');
    const merged = actions.map((existing, index) => {
      const incoming = input.actions[index];
      if (!incoming || (user.role !== 'admin' && existing.owner !== displayName)) return existing;
      return {
        ...existing,
        owner_feedback: incoming.owner_feedback ?? existing.owner_feedback,
        feedback_date: incoming.feedback_date ?? existing.feedback_date,
      };
    });
    const updated = updateRecord('ProductionIssue', issue.id, {
      corrective_actions_json: JSON.stringify(merged),
      feedback_pending: merged.some(action => Boolean(action.owner_feedback?.trim())),
    }, user, true);
    return { success: true, corrective_actions_json: updated.corrective_actions_json };
  }
  if (name === 'regenerateLearnedLessons') {
    if (user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
    const corrections = listRecords('VisualInspectionEntry', { human_validated: true, human_agrees_with_ai: false }, '-validated_at', 500)
      .filter(entry => entry.human_corrected_label?.trim() || entry.human_feedback?.trim());
    const existing = listRecords('AiLearnedLessons', {}, '-generated_at', 1)[0];
    let summary = '';
    if (corrections.length) {
      const text = corrections.map((entry, index) => [
        `${index + 1}. Part: ${entry.part_number || '—'}, Client: ${entry.client || '—'}`,
        entry.human_corrected_label ? `   Human correction: ${entry.human_corrected_label}` : '',
        entry.human_feedback ? `   Feedback: ${entry.human_feedback}` : '',
      ].filter(Boolean).join('\n')).join('\n');
      const result = await invokeLlm({
        prompt: `You are a quality inspection expert for aviation parts. Summarize patterns in these human corrections in actionable bullet points, maximum 500 words. Do not list every correction.\n\n${text}`,
        response_json_schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      });
      summary = result.summary || '';
    }
    const payload = {
      summary_text: summary,
      corrections_count: corrections.length,
      last_correction_id: corrections[0]?.id || '',
      generated_at: new Date().toISOString(),
      generated_by: user.email,
    };
    if (existing) updateRecord('AiLearnedLessons', existing.id, payload, user);
    else createRecord('AiLearnedLessons', payload, user);
    return { summary, count: corrections.length, message: 'Lessons regenerated successfully' };
  }
  if (name === 'correctiveActionReminder') {
    requireAdmin(user);
    return { sent: await sendCorrectiveActionReminders() };
  }
  if (name === 'sendStandupReminders') {
    requireAdmin(user);
    return { sent: await sendStandupReminders() };
  }
  if (name === 'criticalIssueAlert') {
    requireAdmin(user);
    if (!input.data || input.data.severity !== 'critical') return { skipped: true, reason: 'Not critical' };
    return sendCriticalIssueAlert(input.data);
  }
  if (name === 'invokeLLM') return invokeLlm(input);
  if (name === 'sendEmail') return sendEmail(input);
  throw new HttpError(404, `Unknown server function: ${name}`);
}

async function sendCriticalIssueAlert(issue) {
  if (!process.env.CRITICAL_ALERT_TO) {
    throw new HttpError(503, 'Critical-issue email is not configured. Set CRITICAL_ALERT_TO on the server.');
  }
  const issueNumber = issue.issue_number || issue.id || '—';
  await sendEmail({
    to: process.env.CRITICAL_ALERT_TO,
    subject: `Critical production issue: ${issueNumber} - ${issue.title || 'Untitled'}`,
    body: `A critical production issue needs review.\n\nIssue: ${issueNumber}\nTitle: ${issue.title || '—'}\nDescription: ${issue.defect_description || '—'}\nDowntime started: ${issue.downtime_start || '—'}`,
  });
  return { sent: true, issue_number: issueNumber };
}

function dispatchBackground(label, task) {
  setImmediate(() => {
    Promise.resolve().then(task).catch(error => {
      console.error(`${label}: ${error.message}`);
    });
  });
}

function scheduleLessonRegeneration(record, previous = null) {
  const isCorrection = record?.human_validated
    && record.human_agrees_with_ai === false
    && Boolean(record.human_corrected_label?.trim() || record.human_feedback?.trim());
  const wasCorrection = previous?.human_validated
    && previous.human_agrees_with_ai === false
    && Boolean(previous.human_corrected_label?.trim() || previous.human_feedback?.trim());
  if (!isCorrection || (wasCorrection
    && previous.human_corrected_label === record.human_corrected_label
    && previous.human_feedback === record.human_feedback)) return;
  if (!process.env.AI_API_KEY) {
    console.warn('A visual-inspection correction was saved; automatic lesson generation needs AI_API_KEY.');
    return;
  }
  const admin = database.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
  if (admin) dispatchBackground('Could not regenerate inspection lessons', () => runFunction('regenerateLearnedLessons', {}, admin));
}

async function uploadFile(input) {
  if (!input || typeof input.file_data !== 'string' || typeof input.file_name !== 'string') {
    throw new HttpError(400, 'A file name and base64-encoded file are required.');
  }
  const type = String(input.file_type || '').toLowerCase();
  const extension = allowedUploadTypes.get(type);
  if (!extension) throw new HttpError(415, 'This file type is not supported.');
  const encoded = input.file_data.replace(/^data:[^,]+;base64,/, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) throw new HttpError(400, 'The uploaded file is empty.');
  if (bytes.length > 15 * 1024 * 1024) throw new HttpError(413, 'Files are limited to 15 MB.');
  const filename = `${randomUUID()}${extension}`;
  await writeFile(path.join(uploadsDirectory, filename), bytes, { flag: 'wx' });
  return { file_url: `/uploads/${filename}`, file_name: path.basename(input.file_name) };
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
  })[extension] || 'application/octet-stream';
}

async function serveFile(response, filePath) {
  const contents = await readFile(filePath);
  response.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  response.end(contents);
}

async function serveStatic(request, response, pathname) {
  if (pathname.startsWith('/uploads/')) {
    const filename = path.basename(decodeURIComponent(pathname.slice('/uploads/'.length)));
    if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(filename)) throw new HttpError(404, 'File not found.');
    return serveFile(response, path.join(uploadsDirectory, filename));
  }
  const dist = path.join(root, 'dist');
  const decodedPath = decodeURIComponent(pathname);
  const requested = decodedPath === '/' ? path.join(dist, 'index.html') : path.resolve(dist, `.${decodedPath}`);
  if (!requested.startsWith(`${dist}${path.sep}`) && requested !== path.join(dist, 'index.html')) {
    throw new HttpError(400, 'Invalid file path.');
  }
  try {
    return await serveFile(response, requested);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return serveFile(response, path.join(dist, 'index.html'));
  }
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    if (request.method !== 'GET' && request.headers['x-app-request'] !== 'true') {
      throw new HttpError(403, 'Request verification failed.');
    }
    if (request.method === 'GET' && pathname === '/api/status') {
      return sendJson(response, 200, { hasUsers: Boolean(database.prepare('SELECT 1 FROM users LIMIT 1').get()) });
    }
    if (request.method === 'POST' && pathname === '/api/auth/bootstrap') {
      const input = await readBody(request);
      const createFirstAdmin = () => transaction(() => {
        if (database.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(409, 'An administrator has already been created.');
        return createUser({ ...input, role: 'admin' });
      });
      const user = createFirstAdmin();
      createSession(response, user);
      return sendJson(response, 201, publicUser(user));
    }
    if (request.method === 'POST' && pathname === '/api/auth/login') {
      checkLoginAttempts(request);
      const input = await readBody(request);
      const account = database.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(input.email || '').trim());
      if (!account || !verifyPassword(String(input.password || ''), account.password_hash)) {
        recordLoginFailure(request);
        throw new HttpError(401, 'Email or password is incorrect.');
      }
      loginFailures.delete(loginKey(request));
      createSession(response, account);
      return sendJson(response, 200, publicUser(account));
    }
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      return sendJson(response, 200, publicUser(requireUser(request)));
    }
    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      clearSession(request, response);
      return sendJson(response, 200, { success: true });
    }
    if (pathname === '/api/auth/change-password' && request.method === 'POST') {
      const user = requireUser(request);
      const input = await readBody(request);
      const account = database.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (!verifyPassword(String(input.current_password || ''), account.password_hash)) {
        throw new HttpError(401, 'Current password is incorrect.');
      }
      if (typeof input.new_password !== 'string' || input.new_password.length < 12) {
        throw new HttpError(400, 'Passwords must be at least 12 characters long.');
      }
      database.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(hashPassword(input.new_password), user.id);
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      response.setHeader('Set-Cookie', sessionCookie('', 0));
      return sendJson(response, 200, { success: true });
    }
    if (pathname === '/api/auth/users' && request.method === 'POST') {
      const user = requireUser(request);
      requireAdmin(user);
      const created = createUser(await readBody(request));
      return sendJson(response, 201, publicUser(created));
    }
    if (pathname === '/api/integrations/upload' && request.method === 'POST') {
      requireUser(request);
      return sendJson(response, 201, await uploadFile(await readBody(request, 22 * 1024 * 1024)));
    }
    const functionMatch = /^\/api\/functions\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (functionMatch && request.method === 'POST') {
      const user = requireUser(request);
      const result = await runFunction(functionMatch[1], await readBody(request), user);
      return sendJson(response, 200, result);
    }
    const entityMatch = /^\/api\/entities\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(pathname);
    if (entityMatch) {
      const [, entity, idOrAction] = entityMatch;
      if (!allowedEntities.has(entity)) throw new HttpError(404, 'Unknown data collection.');
      const user = requireUser(request);
      if (request.method === 'GET' && !idOrAction) {
        const filter = url.searchParams.has('filter') ? parseQueryValue(url.searchParams.get('filter'), 'filter') : {};
        const sort = url.searchParams.get('sort');
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 1000), 0), 50000);
        return sendJson(response, 200, listRecords(entity, filter, sort, limit));
      }
      if (request.method === 'GET' && idOrAction && idOrAction !== 'bulk-update') {
        const item = entity === 'User'
          ? listUsers({}, null, 500).find(account => account.id === idOrAction)
          : getRecord(entity, idOrAction);
        if (!item) throw new HttpError(404, 'Record not found.');
        if (entity === 'User' && user.role !== 'admin' && user.id !== item.id) requireAdmin(user);
        return sendJson(response, 200, item);
      }
      if (request.method === 'POST' && idOrAction === 'bulk') {
        const input = await readBody(request);
        if (!Array.isArray(input)) throw new HttpError(400, 'Bulk data must be an array.');
        const insert = () => transaction(() => input.map(item => createRecord(entity, item, user)));
        const created = insert();
        for (const record of created) {
          if (entity === 'ProductionIssue' && record.severity === 'critical' && process.env.CRITICAL_ALERT_TO) {
            dispatchBackground('Critical issue alert failed', () => sendCriticalIssueAlert(record));
          }
          if (entity === 'VisualInspectionEntry') scheduleLessonRegeneration(record);
        }
        return sendJson(response, 201, created);
      }
      if (request.method === 'POST' && idOrAction === 'bulk-update') {
        const input = await readBody(request);
        if (!Array.isArray(input)) throw new HttpError(400, 'Bulk updates must be an array.');
        const update = () => transaction(() => input.map(item => {
          if (!item?.id) throw new HttpError(400, 'Every bulk update requires an id.');
          const { id, ...patch } = item;
          return updateRecord(entity, id, patch, user);
        }));
        return sendJson(response, 200, update());
      }
      if (request.method === 'POST' && !idOrAction) {
        const created = createRecord(entity, await readBody(request), user);
        if (entity === 'ProductionIssue' && created.severity === 'critical' && process.env.CRITICAL_ALERT_TO) {
          dispatchBackground('Critical issue alert failed', () => sendCriticalIssueAlert(created));
        }
        if (entity === 'VisualInspectionEntry') scheduleLessonRegeneration(created);
        return sendJson(response, 201, created);
      }
      if (request.method === 'PATCH' && idOrAction) {
        const previous = entity === 'VisualInspectionEntry' ? getRecord(entity, idOrAction) : null;
        const updated = updateRecord(entity, idOrAction, await readBody(request), user);
        if (entity === 'VisualInspectionEntry') scheduleLessonRegeneration(updated, previous);
        return sendJson(response, 200, updated);
      }
      if (request.method === 'DELETE' && idOrAction) {
        return sendJson(response, 200, deleteRecord(entity, idOrAction, user));
      }
    }
    throw new HttpError(404, 'API route not found.');
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(404, 'Route not found.');
  }
  return serveStatic(request, response, pathname);
}

async function reminderRecipients() {
  return listUsers({}, null, 500);
}

async function sendCorrectiveActionReminders() {
  const users = await reminderRecipients();
  const emailByName = new Map();
  for (const account of users) {
    const email = account.email;
    for (const key of [account.display_name, account.full_name, email]) {
      if (key) emailByName.set(key.toLowerCase(), email);
    }
  }
  const issues = listRecords('ProductionIssue', {}, null, 50000).filter(issue => issue.status !== 'closed');
  const today = new Date().toISOString().slice(0, 10);
  const sent = [];
  for (const issue of issues) {
    let actions = [];
    try {
      actions = JSON.parse(issue.corrective_actions_json || '[]');
    } catch {
      console.error(`Skipping invalid corrective action JSON on issue ${issue.id}.`);
      continue;
    }
    for (const action of actions) {
      if (!action.owner || !action.due_date || action.completed_date || action.due_date > today) continue;
      const email = emailByName.get(action.owner.toLowerCase());
      if (!email) continue;
      const issueRef = issue.issue_number || issue.id;
      const description = action.action || action.description || action.corrective_action || '(no description)';
      await sendEmail({
        to: email,
        subject: `Action reminder - ${issueRef}: ${issue.title || issueRef}`,
        body: `Issue: ${issueRef}\nAction: ${description}\nDue date: ${action.due_date}`,
      });
      sent.push({ email, issue: issueRef, due_date: action.due_date });
    }
  }
  return sent;
}

async function sendStandupReminders() {
  const points = listRecords('StandupPoint', {}, null, 50000);
  const today = new Date().toISOString().slice(0, 10);
  const sent = [];
  for (const point of points) {
    if (point.is_archived || point.status === 'Resolved') continue;
    const rows = point.category === 'Materiale'
      ? (() => {
          try { return JSON.parse(point.description || '[]'); } catch { return []; }
        })()
      : [{
          owner: point.owner_email,
          action: point.action,
          due_date: point.due_date,
          description: point.description,
          category: point.category,
        }];
    for (const row of rows) {
      const email = row.responsabil || row.owner;
      const action = row.actiune || row.action;
      const dueDate = row.termen || row.due_date;
      if (!email || !action || !dueDate || dueDate > today) continue;
      await sendEmail({
        to: email,
        subject: `Standup reminder - ${point.category || row.category || ''}`,
        body: `Description: ${row.mat_lipsa || row.description || point.description || '-'}\nAction: ${action}\nDue date: ${dueDate}`,
      });
      sent.push({ email, due_date: dueDate });
    }
  }
  return sent;
}

async function runScheduledReminders() {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return;
  const now = new Date();
  if (now.getUTCHours() < 5) return;
  const today = now.toISOString().slice(0, 10);
  for (const [name, send] of [
    ['corrective-actions', sendCorrectiveActionReminders],
    ['standup', sendStandupReminders],
  ]) {
    const claim = database.prepare('INSERT OR IGNORE INTO scheduled_runs (name, run_date) VALUES (?, ?)')
      .run(name, today);
    if (!claim.changes) continue;
    try {
      const sent = await send();
      console.info(`Sent ${sent.length} ${name} reminders for ${today}.`);
    } catch (error) {
      database.prepare('DELETE FROM scheduled_runs WHERE name = ? AND run_date = ?').run(name, today);
      console.error(`Could not send ${name} reminders: ${error.message}`);
    }
  }
}

const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error instanceof HttpError ? error.message : error);
    if (!response.headersSent) {
      sendJson(response, status, { error: error.message || 'Internal server error.' });
    } else {
      response.destroy();
    }
  });
});

server.listen(port, () => {
  console.info(`RCCA server listening on http://localhost:${port}`);
  runScheduledReminders().catch(error => console.error(`Reminder scheduler failed: ${error.message}`));
});
const scheduler = setInterval(() => {
  runScheduledReminders().catch(error => console.error(`Reminder scheduler failed: ${error.message}`));
}, 60 * 1000);

function shutdown() {
  clearInterval(scheduler);
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
