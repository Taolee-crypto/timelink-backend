-- Persist email verification status on the shared personal/business account.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- Preserve accounts created before persistent verification tracking was introduced.
UPDATE users SET email_verified=1;
