CREATE TABLE IF NOT EXISTS office_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), -- Strictly forces only one row to exist
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    radius_meters INTEGER NOT NULL,
    allowed_ips TEXT NOT NULL
);

-- Insert default placeholder values (Teleposta Towers coordinates)
INSERT OR IGNORE INTO office_settings (id, latitude, longitude, radius_meters, allowed_ips) 
VALUES (1, -1.2855, 36.8176, 50, '123.45.67.89');