-- 1. Support Multiple Office Locations
CREATE TABLE IF NOT EXISTS office_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    radius_meters INTEGER NOT NULL,
    allowed_ips TEXT NOT NULL
);

-- Migrate your existing single location into the new table
INSERT INTO office_locations (name, latitude, longitude, radius_meters, allowed_ips) 
SELECT 'HQ', latitude, longitude, radius_meters, allowed_ips FROM office_settings WHERE id = 1;

-- 2. Anti-Tampering Nonces (Short-lived tokens)
CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Immutable Admin Audit Logs
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target_employee TEXT NOT NULL,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Employee Status Tracking
ALTER TABLE employees ADD COLUMN status TEXT DEFAULT 'active';
