-- Per-Lambda PostgreSQL roles with fine-grained table permissions
-- Auto-generated from @RequiresTable decorators

-- CREATE ROLES

CREATE ROLE lambda_api_gateway_authorizer WITH LOGIN;
CREATE ROLE lambda_cleanup_expired_records WITH LOGIN;
CREATE ROLE lambda_device_event WITH LOGIN;
CREATE ROLE lambda_device_register WITH LOGIN;
CREATE ROLE lambda_endpoint_cleanup_helpers WITH LOGIN;
CREATE ROLE lambda_feedly_webhook WITH LOGIN;
CREATE ROLE lambda_files_by_id_delete WITH LOGIN;
CREATE ROLE lambda_files_get WITH LOGIN;
CREATE ROLE lambda_prune_devices WITH LOGIN;
CREATE ROLE lambda_s3_object_created WITH LOGIN;
CREATE ROLE lambda_send_push_notification WITH LOGIN;
CREATE ROLE lambda_start_file_upload WITH LOGIN;
CREATE ROLE lambda_user_delete WITH LOGIN;
CREATE ROLE lambda_user_login WITH LOGIN;
CREATE ROLE lambda_user_logout WITH LOGIN;
CREATE ROLE lambda_user_refresh WITH LOGIN;
CREATE ROLE lambda_user_register WITH LOGIN;
CREATE ROLE lambda_user_subscribe WITH LOGIN;

-- GRANT TABLE PERMISSIONS

-- ApiGatewayAuthorizer
GRANT SELECT, UPDATE ON sessions TO lambda_api_gateway_authorizer;

-- CleanupExpiredRecords
GRANT DELETE, SELECT ON device_events TO lambda_cleanup_expired_records;

-- DeviceEvent
GRANT INSERT, SELECT ON device_events TO lambda_device_event;
GRANT SELECT, UPDATE ON devices TO lambda_device_event;
GRANT SELECT ON user_devices TO lambda_device_event;

-- DeviceRegister
GRANT DELETE, INSERT, SELECT, UPDATE ON devices TO lambda_device_register;
GRANT DELETE, INSERT, SELECT ON user_devices TO lambda_device_register;

-- EndpointCleanupHelpers
GRANT DELETE, SELECT ON devices TO lambda_endpoint_cleanup_helpers;
GRANT DELETE, SELECT ON user_devices TO lambda_endpoint_cleanup_helpers;

-- FeedlyWebhook
GRANT INSERT, SELECT ON file_downloads TO lambda_feedly_webhook;
GRANT INSERT, SELECT ON files TO lambda_feedly_webhook;
GRANT INSERT, SELECT ON user_files TO lambda_feedly_webhook;

-- FilesByIdDelete
GRANT DELETE, SELECT ON file_downloads TO lambda_files_by_id_delete;
GRANT DELETE, SELECT ON files TO lambda_files_by_id_delete;
GRANT DELETE, SELECT ON user_files TO lambda_files_by_id_delete;

-- FilesGet
GRANT INSERT, SELECT ON file_downloads TO lambda_files_get;
GRANT INSERT, SELECT ON files TO lambda_files_get;
GRANT SELECT ON user_files TO lambda_files_get;

-- PruneDevices
GRANT DELETE, SELECT ON devices TO lambda_prune_devices;
GRANT DELETE, SELECT ON user_devices TO lambda_prune_devices;

-- S3ObjectCreated
GRANT SELECT ON files TO lambda_s3_object_created;
GRANT SELECT ON user_files TO lambda_s3_object_created;

-- SendPushNotification
GRANT DELETE, SELECT ON devices TO lambda_send_push_notification;
GRANT DELETE, SELECT ON user_devices TO lambda_send_push_notification;

-- StartFileUpload
GRANT INSERT, SELECT, UPDATE ON file_downloads TO lambda_start_file_upload;
GRANT INSERT, SELECT, UPDATE ON files TO lambda_start_file_upload;
GRANT SELECT ON user_files TO lambda_start_file_upload;

-- UserDelete
GRANT DELETE, SELECT ON devices TO lambda_user_delete;
GRANT DELETE, SELECT ON user_devices TO lambda_user_delete;
GRANT DELETE, SELECT ON user_files TO lambda_user_delete;
GRANT DELETE, SELECT ON users TO lambda_user_delete;

-- UserLogin
GRANT SELECT, INSERT, UPDATE ON users TO lambda_user_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO lambda_user_login;
GRANT SELECT, INSERT, DELETE ON accounts TO lambda_user_login;
GRANT SELECT, INSERT, DELETE ON verification TO lambda_user_login;

-- UserLogout
GRANT SELECT, INSERT, UPDATE ON users TO lambda_user_logout;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO lambda_user_logout;
GRANT SELECT, INSERT, DELETE ON accounts TO lambda_user_logout;
GRANT SELECT, INSERT, DELETE ON verification TO lambda_user_logout;

-- UserRefresh
GRANT SELECT, INSERT, UPDATE ON users TO lambda_user_refresh;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO lambda_user_refresh;
GRANT SELECT, INSERT, DELETE ON accounts TO lambda_user_refresh;
GRANT SELECT, INSERT, DELETE ON verification TO lambda_user_refresh;

-- UserRegister
GRANT SELECT, INSERT, DELETE ON accounts TO lambda_user_register;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO lambda_user_register;
GRANT SELECT, UPDATE, INSERT ON users TO lambda_user_register;
GRANT SELECT, INSERT, DELETE ON verification TO lambda_user_register;

-- UserSubscribe
GRANT DELETE, SELECT ON devices TO lambda_user_subscribe;
GRANT DELETE, SELECT ON user_devices TO lambda_user_subscribe;

-- AWS IAM GRANT

AWS IAM GRANT lambda_api_gateway_authorizer TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-ApiGatewayAuthorizer';
AWS IAM GRANT lambda_cleanup_expired_records TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-CleanupExpiredRecords';
AWS IAM GRANT lambda_device_event TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-DeviceEvent';
AWS IAM GRANT lambda_device_register TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-DeviceRegister';
AWS IAM GRANT lambda_endpoint_cleanup_helpers TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-EndpointCleanupHelpers';
AWS IAM GRANT lambda_feedly_webhook TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-FeedlyWebhook';
AWS IAM GRANT lambda_files_by_id_delete TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-FilesByIdDelete';
AWS IAM GRANT lambda_files_get TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-FilesGet';
AWS IAM GRANT lambda_prune_devices TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-PruneDevices';
AWS IAM GRANT lambda_s3_object_created TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-S3ObjectCreated';
AWS IAM GRANT lambda_send_push_notification TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-SendPushNotification';
AWS IAM GRANT lambda_start_file_upload TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-StartFileUpload';
AWS IAM GRANT lambda_user_delete TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-UserDelete';
AWS IAM GRANT lambda_user_login TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-UserLogin';
AWS IAM GRANT lambda_user_logout TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-UserLogout';
AWS IAM GRANT lambda_user_refresh TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-UserRefresh';
AWS IAM GRANT lambda_user_register TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-UserRegister';
AWS IAM GRANT lambda_user_subscribe TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-UserSubscribe';
