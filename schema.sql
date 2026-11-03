-- Employees table
CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_number TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    device_token TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Attendance logs table
CREATE TABLE IF NOT EXISTS attendance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_number TEXT NOT NULL,
    action_type TEXT NOT NULL, -- 'SIGN_IN' or 'SIGN_OUT'
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    latitude REAL,
    longitude REAL,
    distance_meters REAL,
    ip_address TEXT,
    verified INTEGER DEFAULT 0, -- 1 if within geofence and IP match, 0 if flagged
    flag_reason TEXT,
    FOREIGN KEY (emp_number) REFERENCES employees(emp_number)
);