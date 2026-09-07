CREATE TABLE metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
    ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    distribution TEXT NOT NULL CHECK (distribution IN ('arch', 'debian')),
    port INTEGER NOT NULL UNIQUE CHECK (port >= 19500 AND port < 20000),
    started_ms INTEGER NOT NULL CHECK (started_ms >= 0),
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    error TEXT,
    installed_version TEXT,
    repair_available INTEGER NOT NULL CHECK (repair_available IN (0, 1)),
    version_error TEXT,
    upgrade_started_ms INTEGER NOT NULL CHECK (upgrade_started_ms >= 0),
    upgrade_target TEXT
) STRICT;

CREATE TABLE session_settings (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('desired', 'applied', 'launching')),
    width INTEGER,
    height INTEGER,
    kiosk INTEGER NOT NULL CHECK (kiosk IN (0, 1)),
    startup_command TEXT NOT NULL,
    PRIMARY KEY (session_id, kind),
    CHECK ((width IS NULL AND height IS NULL) OR
           (width IS NOT NULL AND height IS NOT NULL AND
            width BETWEEN 2 AND 8192 AND height BETWEEN 2 AND 8192 AND
            width % 2 = 0 AND height % 2 = 0))
) STRICT;

CREATE TABLE session_packages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL,
    PRIMARY KEY (session_id, position)
) STRICT;

CREATE TABLE session_timings (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
    PRIMARY KEY (session_id, stage)
) STRICT;
