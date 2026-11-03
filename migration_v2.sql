-- 1. Add the Division column to the existing employees table
-- We assign a default value so your current test account doesn't break the database
ALTER TABLE employees ADD COLUMN division TEXT DEFAULT 'Unassigned';

-- 2. Create the Exceptions table for out-of-office tracking
CREATE TABLE IF NOT EXISTS status_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_number TEXT NOT NULL,
    type TEXT NOT NULL,          -- e.g., 'Workshop', 'Sick Leave', 'Annual Leave'
    start_date DATE NOT NULL,    -- Format: YYYY-MM-DD
    end_date DATE NOT NULL,      -- Format: YYYY-MM-DD
    description TEXT,            -- Used for Workshop/Inspection details
    notified_person TEXT,        -- Used for accountability on Sick/Annual leave
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (emp_number) REFERENCES employees(emp_number)
);