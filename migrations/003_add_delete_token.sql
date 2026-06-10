-- Empty means "no delete token": uploads from before this migration can
-- never be deleted via the delete API, only by expiry.
ALTER TABLE uploads ADD COLUMN delete_token TEXT NOT NULL DEFAULT '';
