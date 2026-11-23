CREATE TABLE archive (
  actor TEXT NOT NULL,
  job_phase TEXT NOT NULL,
  attempt TEXT NOT NULL,
  created INTEGER NOT NULL,
  run TEXT,
  confirmed INTEGER,
  result TEXT,
  captured INTEGER,
  state_saved INTEGER,
  PRIMARY KEY(actor,job_phase),
  UNIQUE(actor,run),
  CHECK ((run IS NULL) = (confirmed IS NULL)),
  CHECK ((result IS NULL) = (captured IS NULL)),
  CHECK (result IS NULL OR run IS NOT NULL)
);
CREATE TABLE profiles (actor TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE personal_state (actor TEXT PRIMARY KEY, version INTEGER NOT NULL, snapshot TEXT NOT NULL);
