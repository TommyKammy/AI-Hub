CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE grants (actor TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(actor,document));
CREATE TABLE consultations (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, ask TEXT NOT NULL,
  attached TEXT NOT NULL, expected TEXT NOT NULL, deadline INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT ('waiting'), job TEXT UNIQUE, claim TEXT UNIQUE, request_hash TEXT,
  CHECK(attached <> expected)
);
CREATE TABLE inbox (
  consultation TEXT PRIMARY KEY REFERENCES consultations(id), actor TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TRIGGER deadline_notice AFTER UPDATE OF state ON consultations
WHEN NEW.state = 'expired' AND OLD.state = 'waiting'
BEGIN
  INSERT INTO inbox VALUES(NEW.id, NEW.actor, unixepoch()*1000);
END;
CREATE TABLE source_reads (consultation TEXT, document TEXT, PRIMARY KEY(consultation,document));
