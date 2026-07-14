-- Create the settings table for centralized runtime configuration
CREATE TABLE IF NOT EXISTS settings (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value TEXT,
    encrypted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Add an index on the key column for fast lookups
CREATE INDEX IF NOT EXISTS idx_settings_key ON settings (key);