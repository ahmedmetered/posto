// SQLite storage (node:sqlite, no dependencies). One shared jobs table, everything else is per user.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, ext_id TEXT NOT NULL, company TEXT NOT NULL, title TEXT NOT NULL,
  location TEXT DEFAULT '', remote INTEGER, employment TEXT, description TEXT DEFAULT '', url TEXT NOT NULL,
  salary_json TEXT, sponsorship INTEGER, languages_json TEXT, posted_at TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  UNIQUE(source, ext_id)
);
CREATE TABLE IF NOT EXISTS user_jobs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL, score INTEGER NOT NULL, reasons_json TEXT NOT NULL, track TEXT, cv TEXT,
  state TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, PRIMARY KEY (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS user_jobs_feed ON user_jobs(user_id, state, verdict, score DESC);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  company TEXT NOT NULL, role TEXT NOT NULL, url TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'Found', cv TEXT DEFAULT '',
  notes TEXT DEFAULT '', salary TEXT DEFAULT '', location TEXT DEFAULT '', top INTEGER DEFAULT 0, easy INTEGER DEFAULT 0,
  date_applied TEXT DEFAULT '', added TEXT NOT NULL, updated TEXT NOT NULL, unread INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS applications_user ON applications(user_id, status);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  ext_id TEXT NOT NULL, dir TEXT NOT NULL, platform TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL, UNIQUE(application_id, ext_id)
);
CREATE TABLE IF NOT EXISTS mail_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL, mail_user TEXT NOT NULL, pass_enc TEXT NOT NULL,
  host TEXT NOT NULL, port INTEGER NOT NULL, secure INTEGER NOT NULL DEFAULT 1, folders_json TEXT NOT NULL DEFAULT '["INBOX"]',
  skip_json TEXT NOT NULL DEFAULT '[]', last_check TEXT, last_result TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS mail_seen (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, msg_id TEXT NOT NULL, PRIMARY KEY (user_id, msg_id)
);
CREATE TABLE IF NOT EXISTS mail_review (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, date TEXT, sender TEXT, subject TEXT,
  kind TEXT, match TEXT, hint TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (user_id, k)
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cvs (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
  filename TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY, ats TEXT NOT NULL, slug TEXT NOT NULL, label TEXT DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(ats, slug)
);
`;

export function openDb(file = path.resolve("data/app.db")) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();
