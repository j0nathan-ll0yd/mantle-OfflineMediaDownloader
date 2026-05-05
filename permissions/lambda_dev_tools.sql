-- Ejected per C22: DevTools MCP handler needs SELECT on all tables for schema introspection
-- and ad-hoc read-only queries. Cannot be auto-generated because defineQuery does not
-- support ALL TABLES grants.

CREATE ROLE lambda_dev_tools WITH LOGIN;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO lambda_dev_tools;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO lambda_dev_tools;

AWS IAM GRANT lambda_dev_tools TO 'arn:aws:iam::${AWS_ACCOUNT_ID}:role/${RESOURCE_PREFIX}-DevTools';
