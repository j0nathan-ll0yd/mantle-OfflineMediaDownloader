-- Retire 13 legacy per-Lambda PG roles left over from the pre-rename role scheme.
--
-- Why this migration exists:
-- applyPermissions() in @j0nathan-ll0yd/database drops orphan `lambda_%` roles on
-- every deploy, but it issues a bare `DROP ROLE` with no privilege cleanup first.
-- Each of these roles still holds table ACL grants (pg_shdepend deptype='a' on
-- pg_class), so every deploy logs:
--   Warning: could not drop role <X>: role "X" cannot be dropped because some
--   objects depend on it
-- This migration removes the blocking grants so the DROP succeeds. The upstream
-- cleanup then finds nothing to do and the warnings stop.
--
-- Aurora DSQL compatibility:
-- `DROP OWNED BY` / `REASSIGN OWNED BY` are absent from the Aurora DSQL supported-SQL
-- reference in either direction, so they are not used here. `REVOKE (ON, FROM, CASCADE,
-- RESTRICT)` is explicitly listed as supported DCL, and `DROP ROLE` is documented in the
-- DSQL troubleshooting guide (it is exactly the command emitting the warning above).
-- No `ALTER ... OWNER TO` is needed: all 11 tables in `public` are owned by `admin` and
-- none of these roles owns any object (verified via pg_class.relowner).
-- No `AWS IAM REVOKE` is needed: none of these roles has a row in
-- sys.iam_pg_role_mappings, which is also the proof that no Lambda can reach them --
-- a Lambda authenticates to DSQL through an IAM-to-PG-role mapping, and there is none.
--
-- Every REVOKE below corresponds to a real ACL entry observed in staging pg_class.relacl.

-- lambda_download_orchestrator (superseded: DownloadOrchestrator Lambda removed)
REVOKE ALL PRIVILEGES ON files FROM lambda_download_orchestrator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON file_downloads FROM lambda_download_orchestrator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON user_files FROM lambda_download_orchestrator;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_download_orchestrator;
--> statement-breakpoint

-- lambda_failure_handler (superseded: FailureHandler Lambda removed)
REVOKE ALL PRIVILEGES ON files FROM lambda_failure_handler;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON file_downloads FROM lambda_failure_handler;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON user_files FROM lambda_failure_handler;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_failure_handler;
--> statement-breakpoint

-- lambda_file_helpers (superseded: FileHelpers Lambda removed)
REVOKE ALL PRIVILEGES ON files FROM lambda_file_helpers;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_file_helpers;
--> statement-breakpoint

-- lambda_files_file_id_delete (superseded by lambda_files_by_id_delete)
REVOKE ALL PRIVILEGES ON files FROM lambda_files_file_id_delete;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON file_downloads FROM lambda_files_file_id_delete;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON user_files FROM lambda_files_file_id_delete;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_files_file_id_delete;
--> statement-breakpoint

-- lambda_list_files (superseded by lambda_files_get)
REVOKE ALL PRIVILEGES ON files FROM lambda_list_files;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON user_files FROM lambda_list_files;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_list_files;
--> statement-breakpoint

-- lambda_login_user (superseded by lambda_user_login)
REVOKE ALL PRIVILEGES ON users FROM lambda_login_user;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON sessions FROM lambda_login_user;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON accounts FROM lambda_login_user;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_login_user;
--> statement-breakpoint

-- lambda_logout_user (superseded by lambda_user_logout)
REVOKE ALL PRIVILEGES ON sessions FROM lambda_logout_user;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_logout_user;
--> statement-breakpoint

-- lambda_push_helpers (superseded: PushHelpers Lambda removed)
REVOKE ALL PRIVILEGES ON devices FROM lambda_push_helpers;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON user_devices FROM lambda_push_helpers;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_push_helpers;
--> statement-breakpoint

-- lambda_refresh_token (superseded by lambda_user_refresh)
REVOKE ALL PRIVILEGES ON sessions FROM lambda_refresh_token;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_refresh_token;
--> statement-breakpoint

-- lambda_register_device (superseded by lambda_device_register)
REVOKE ALL PRIVILEGES ON devices FROM lambda_register_device;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON user_devices FROM lambda_register_device;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_register_device;
--> statement-breakpoint

-- lambda_register_user (superseded by lambda_user_register)
REVOKE ALL PRIVILEGES ON users FROM lambda_register_user;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_register_user;
--> statement-breakpoint

-- lambda_s3_recovery (superseded: S3Recovery Lambda removed)
REVOKE ALL PRIVILEGES ON files FROM lambda_s3_recovery;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON file_downloads FROM lambda_s3_recovery;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON user_files FROM lambda_s3_recovery;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_s3_recovery;
--> statement-breakpoint

-- lambda_webhook_feedly (superseded by lambda_feedly_webhook)
REVOKE ALL PRIVILEGES ON files FROM lambda_webhook_feedly;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON file_downloads FROM lambda_webhook_feedly;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON user_files FROM lambda_webhook_feedly;
--> statement-breakpoint
DROP ROLE IF EXISTS lambda_webhook_feedly;
