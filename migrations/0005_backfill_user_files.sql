-- Remove erroneous default file associations
-- The default file is a static asset for anonymous users and should never
-- be linked to registered users via the user_files junction table.
DELETE FROM user_files WHERE file_id = 'default';
--> statement-breakpoint

-- Backfill user_files for all existing files (excluding default) for all registered users.
-- This is idempotent (ON CONFLICT DO NOTHING) and safe to re-run.
-- The app has only one registered user, so CROSS JOIN correctly associates all files.
INSERT INTO user_files (user_id, file_id, created_at)
SELECT u.id, f.file_id, NOW()
FROM users u
CROSS JOIN files f
WHERE f.file_id != 'default'
ON CONFLICT (user_id, file_id) DO NOTHING;
