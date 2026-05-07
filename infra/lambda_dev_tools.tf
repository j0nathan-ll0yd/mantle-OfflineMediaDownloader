# Ejected per C22: MCP DevTools handler needs env vars (API_BEARER_TOKEN, EVENT_BUS_NAME)
# and IAM policies (CloudWatch Logs, EventBridge, S3 read, STS) that the CLI cannot
# auto-detect from framework-internal getRequiredEnv calls.

# --- DevTools ---

module "lambda_dev_tools" {
  source = "../../mantle/modules/lambda"

  function_name      = "DevTools"
  name_prefix        = module.core.name_prefix
  source_dir         = "${path.module}/../build/lambdas/DevTools"
  assume_role_policy = module.core.lambda_assume_role_policy
  xray_policy_arn    = module.core.lambda_xray_policy_arn
  region             = module.core.region
  account_id         = module.core.account_id
  environment        = var.environment
  log_retention_days = var.log_retention_days
  log_level          = var.log_level
  tags               = module.core.common_tags
  timeout            = 30
  memory_size        = 512

  function_url_enabled   = true
  function_url_auth_type = "NONE"

  api_gateway_enabled = false

  environment_variables = merge(local.common_lambda_env, {
    API_BEARER_TOKEN = var.api_bearer_token
    DSQL_ROLE_NAME   = "lambda_dev_tools"
    DSQL_ENDPOINT    = module.database.cluster_endpoint
    DSQL_REGION      = module.core.region
    DATA_BUCKET      = module.storage_files.bucket_id
    EVENT_BUS_NAME   = local.event_bus_name
  })

  additional_policy_arns = [module.database.connect_policy_arn]

  inline_policies = {
    "S3ReadAccess" = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:ListBucket"]
        Resource = [
          module.storage_files.bucket_arn,
          "${module.storage_files.bucket_arn}/*"
        ]
      }]
    })
    "CloudWatchLogsRead" = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect   = "Allow"
        Action   = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogGroups"]
        Resource = "arn:aws:logs:${module.core.region}:${module.core.account_id}:log-group:/aws/lambda/${module.core.name_prefix}-*:*"
      }]
    })
    "EventBridgeRead" = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect   = "Allow"
        Action   = ["events:ListRules", "events:ListTargetsByRule"]
        Resource = "arn:aws:events:${module.core.region}:${module.core.account_id}:rule/${local.event_bus_name}/*"
        }, {
        Effect   = "Allow"
        Action   = ["events:DescribeEventBus"]
        Resource = module.eventbridge.bus_arn
      }]
    })
  }
}
