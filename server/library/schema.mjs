export const APPLICATION_ID = 0x4543484f
export const SCHEMA_VERSION = 4

export const migrations = [{ version: 1, sql: `
  CREATE TABLE owners (
    user_id TEXT PRIMARY KEY, singleton INTEGER NOT NULL UNIQUE CHECK(singleton = 1), label TEXT NOT NULL
  ) STRICT;
  CREATE TABLE library_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL CHECK(revision >= 0)
  ) STRICT;
  INSERT INTO library_state VALUES (1, 0);
  CREATE TABLE owner_evidence (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES owners(user_id), source_json TEXT NOT NULL,
    UNIQUE(user_id, id)
  ) STRICT;
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES owners(user_id), title TEXT NOT NULL,
    participants_json TEXT NOT NULL, signature TEXT NOT NULL, UNIQUE(user_id, id)
  ) STRICT;
  CREATE TABLE imports (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
    revision INTEGER NOT NULL, UNIQUE(user_id, id), UNIQUE(user_id, conversation_id, id),
    FOREIGN KEY(user_id, conversation_id) REFERENCES conversations(user_id, id),
    FOREIGN KEY(user_id, evidence_id) REFERENCES owner_evidence(user_id, id)
  ) STRICT;
  CREATE TABLE source_parts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, import_id TEXT NOT NULL,
    digest TEXT NOT NULL, source_json TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    UNIQUE(user_id, id), UNIQUE(user_id, conversation_id, digest), UNIQUE(user_id, conversation_id, id),
    FOREIGN KEY(user_id, conversation_id) REFERENCES conversations(user_id, id),
    FOREIGN KEY(user_id, conversation_id, import_id) REFERENCES imports(user_id, conversation_id, id)
  ) STRICT;
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0), sender TEXT NOT NULL, text TEXT NOT NULL, timestamp INTEGER,
    UNIQUE(user_id, id), UNIQUE(user_id, conversation_id, id), UNIQUE(user_id, conversation_id, ordinal),
    FOREIGN KEY(user_id, conversation_id) REFERENCES conversations(user_id, id)
  ) STRICT;
  CREATE TABLE message_versions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
    source_json TEXT NOT NULL, UNIQUE(user_id, id), UNIQUE(user_id, message_id, id),
    FOREIGN KEY(user_id, conversation_id, message_id) REFERENCES messages(user_id, conversation_id, id)
  ) STRICT;
  CREATE TABLE source_occurrences (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, part_id TEXT NOT NULL,
    source_index INTEGER NOT NULL CHECK(source_index >= 0), message_id TEXT NOT NULL, version_id TEXT NOT NULL,
    UNIQUE(user_id, id), UNIQUE(user_id, part_id, source_index),
    FOREIGN KEY(user_id, conversation_id, part_id) REFERENCES source_parts(user_id, conversation_id, id),
    FOREIGN KEY(user_id, conversation_id, message_id) REFERENCES messages(user_id, conversation_id, id),
    FOREIGN KEY(user_id, message_id, version_id) REFERENCES message_versions(user_id, message_id, id)
  ) STRICT;
  CREATE TABLE assets (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES owners(user_id), digest TEXT NOT NULL,
    size INTEGER NOT NULL CHECK(size >= 0), UNIQUE(user_id, id), UNIQUE(user_id, digest)
  ) STRICT;
  CREATE TABLE message_assets (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK(slot >= 0), kind TEXT NOT NULL CHECK(kind IN ('image', 'audio', 'video', 'file')),
    asset_id TEXT, UNIQUE(user_id, id), UNIQUE(user_id, message_id, slot),
    FOREIGN KEY(user_id, conversation_id, message_id) REFERENCES messages(user_id, conversation_id, id),
    FOREIGN KEY(user_id, asset_id) REFERENCES assets(user_id, id)
  ) STRICT;
  CREATE TABLE reading_positions (
    user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
    offset INTEGER NOT NULL, PRIMARY KEY(user_id, conversation_id),
    FOREIGN KEY(user_id, conversation_id, message_id) REFERENCES messages(user_id, conversation_id, id)
  ) STRICT;
  CREATE TRIGGER immutable_source_parts BEFORE UPDATE ON source_parts BEGIN
    SELECT RAISE(ABORT, 'immutable_source');
  END;
  CREATE TRIGGER immutable_message_versions BEFORE UPDATE ON message_versions BEGIN
    SELECT RAISE(ABORT, 'immutable_source');
  END;
  CREATE TRIGGER immutable_source_occurrences BEFORE UPDATE ON source_occurrences BEGIN
    SELECT RAISE(ABORT, 'immutable_source');
  END;
` }, { version: 2, sql: `
  ALTER TABLE conversations ADD COLUMN category TEXT NOT NULL DEFAULT 'Inbox';
  CREATE TABLE owner_identities (
    user_id TEXT NOT NULL REFERENCES owners(user_id), stable_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY(user_id, stable_id)
  ) STRICT;
  CREATE TABLE owner_mappings (
    user_id TEXT NOT NULL REFERENCES owners(user_id), evidence_hash TEXT NOT NULL, label TEXT NOT NULL,
    source_json TEXT NOT NULL, PRIMARY KEY(user_id, evidence_hash)
  ) STRICT;
  CREATE TABLE conversation_observations (
    user_id TEXT NOT NULL, observation_key TEXT NOT NULL, conversation_id TEXT NOT NULL, matcher TEXT NOT NULL,
    PRIMARY KEY(user_id, observation_key),
    FOREIGN KEY(user_id, conversation_id) REFERENCES conversations(user_id, id)
  ) STRICT;
  CREATE TABLE review_decisions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES owners(user_id), observation_key TEXT NOT NULL,
    decision_json TEXT NOT NULL, UNIQUE(user_id, observation_key)
  ) STRICT;
  CREATE TABLE import_history (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES owners(user_id), revision INTEGER NOT NULL,
    summary_json TEXT NOT NULL, UNIQUE(user_id, id)
  ) STRICT;
  CREATE TABLE occurrence_assets (
    user_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, slot INTEGER NOT NULL, uri TEXT NOT NULL, asset_id TEXT,
    PRIMARY KEY(user_id, occurrence_id, slot),
    FOREIGN KEY(user_id, occurrence_id) REFERENCES source_occurrences(user_id, id),
    FOREIGN KEY(user_id, asset_id) REFERENCES assets(user_id, id)
  ) STRICT;
  CREATE TABLE occurrence_asset_versions (
    user_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, slot INTEGER NOT NULL, asset_id TEXT NOT NULL,
    PRIMARY KEY(user_id, occurrence_id, slot, asset_id),
    FOREIGN KEY(user_id, occurrence_id) REFERENCES source_occurrences(user_id, id),
    FOREIGN KEY(user_id, asset_id) REFERENCES assets(user_id, id)
  ) STRICT;
  CREATE TABLE source_assets (
    user_id TEXT NOT NULL, part_id TEXT NOT NULL, uri TEXT NOT NULL, asset_id TEXT NOT NULL,
    PRIMARY KEY(user_id, part_id, uri, asset_id),
    FOREIGN KEY(user_id, part_id) REFERENCES source_parts(user_id, id),
    FOREIGN KEY(user_id, asset_id) REFERENCES assets(user_id, id)
  ) STRICT;
  CREATE TABLE conversation_pictures (
    user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, name TEXT NOT NULL, asset_id TEXT NOT NULL,
    PRIMARY KEY(user_id, conversation_id, name),
    FOREIGN KEY(user_id, conversation_id) REFERENCES conversations(user_id, id),
    FOREIGN KEY(user_id, asset_id) REFERENCES assets(user_id, id)
  ) STRICT;
  CREATE TABLE preferences (
    user_id TEXT NOT NULL REFERENCES owners(user_id), key TEXT NOT NULL, value_json TEXT NOT NULL,
    PRIMARY KEY(user_id, key)
  ) STRICT;
  CREATE INDEX source_occurrences_message ON source_occurrences(user_id, message_id);
  CREATE INDEX message_versions_message ON message_versions(user_id, message_id);
` }, { version: 3, sql: `
  CREATE TABLE discussions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, title TEXT NOT NULL,
    draft TEXT NOT NULL, scope TEXT NOT NULL, draft_revision INTEGER NOT NULL DEFAULT 1, source_version TEXT,
    UNIQUE(user_id,id), UNIQUE(user_id,conversation_id,id),
    FOREIGN KEY(user_id,conversation_id) REFERENCES conversations(user_id,id)
  ) STRICT;
  CREATE TABLE analysis_snapshots (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, discussion_id TEXT NOT NULL,
    library_revision INTEGER NOT NULL, provider_account TEXT NOT NULL, model TEXT NOT NULL, payload_json TEXT NOT NULL, reference_map_json TEXT NOT NULL,
    UNIQUE(user_id,id),
    FOREIGN KEY(user_id,conversation_id,discussion_id) REFERENCES discussions(user_id,conversation_id,id)
  ) STRICT;
  CREATE TABLE analysis_turns (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, discussion_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, status TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', error TEXT,
    UNIQUE(user_id,id), UNIQUE(user_id,discussion_id,sequence),
    FOREIGN KEY(user_id,discussion_id) REFERENCES discussions(user_id,id),
    FOREIGN KEY(user_id,snapshot_id) REFERENCES analysis_snapshots(user_id,id)
  ) STRICT;
  CREATE TRIGGER immutable_analysis_snapshots BEFORE UPDATE ON analysis_snapshots BEGIN
    SELECT RAISE(ABORT, 'immutable_snapshot');
  END;
` }, { version: 4, sql: `
  ALTER TABLE library_state ADD COLUMN cleanup_required INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE analysis_snapshots ADD COLUMN source_evidence_json TEXT;
  CREATE TABLE import_source_parts (
    user_id TEXT NOT NULL, import_id TEXT NOT NULL, part_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
    PRIMARY KEY(user_id,import_id,ordinal),
    FOREIGN KEY(user_id,import_id) REFERENCES imports(user_id,id),
    FOREIGN KEY(user_id,part_id) REFERENCES source_parts(user_id,id)
  ) STRICT;
  INSERT INTO import_source_parts SELECT user_id,import_id,id,ordinal FROM source_parts;
` }]

export function migrate(db, steps = migrations) {
  const version = db.prepare('PRAGMA user_version').get().user_version
  const application = db.prepare('PRAGMA application_id').get().application_id
  if (version > SCHEMA_VERSION) throw new Error('library_schema_newer')
  if (application !== APPLICATION_ID && (application !== 0 || version !== 0 ||
      db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get())) throw new Error('library_invalid_database')
  db.exec('BEGIN IMMEDIATE')
  try {
    let current = version
    for (const step of steps) {
      if (step.version <= current) continue
      if (step.version !== current + 1 || step.version > SCHEMA_VERSION) throw new Error('library_migration_failed')
      db.exec(step.sql)
      db.exec(`PRAGMA user_version = ${step.version}`)
      current = step.version
    }
    if (current !== SCHEMA_VERSION) throw new Error('library_migration_failed')
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    db.exec('COMMIT')
  } catch {
    db.exec('ROLLBACK')
    throw new Error('library_migration_failed')
  }
}
