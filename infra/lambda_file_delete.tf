# Hand-written: requires {fileId} path parameter under /files resource (not CLI-generated)
# Documented per C22: path parameter routing not supported by mantle generate infra

# --- FileDelete ---

# Path parameter resource under /files
resource "aws_api_gateway_resource" "file_delete" {
  rest_api_id = module.api.rest_api_id
  parent_id   = aws_api_gateway_resource.files_get.id
  path_part   = "{fileId}"
}

module "lambda_file_delete" {
  source = "../../mantle/modules/lambda"

  function_name      = "FileDelete"
  name_prefix        = module.core.name_prefix
  source_dir         = "${path.module}/../build/lambdas/FileDelete"
  assume_role_policy = module.core.lambda_gateway_assume_role_policy
  xray_policy_arn    = module.core.lambda_xray_policy_arn
  region             = module.core.region
  account_id         = module.core.account_id
  environment        = var.environment
  log_retention_days = var.log_retention_days
  log_level          = var.log_level
  tags               = module.core.common_tags
  layers             = [local.adot_layer_arn]

  api_gateway_enabled = true

  environment_variables = merge(local.common_lambda_env, {
    DSQL_ROLE_NAME = local.lambda_dsql_roles["FileDelete"].role_name
    DSQL_ENDPOINT  = module.database.cluster_endpoint
    DSQL_REGION    = module.core.region
    BUCKET         = module.storage_files.bucket_id
  })

  additional_policy_arns = [module.database.connect_policy_arn]

  inline_policies = {
    "S3Delete" = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect   = "Allow"
        Action   = ["s3:DeleteObject"]
        Resource = "${module.storage_files.bucket_arn}/*"
      }]
    })
  }
}

resource "aws_api_gateway_method" "file_delete" {
  rest_api_id   = module.api.rest_api_id
  resource_id   = aws_api_gateway_resource.file_delete.id
  http_method   = "DELETE"
  authorization = "CUSTOM"
  authorizer_id = module.api.authorizer_id
}

resource "aws_api_gateway_integration" "file_delete" {
  rest_api_id             = module.api.rest_api_id
  resource_id             = aws_api_gateway_resource.file_delete.id
  http_method             = aws_api_gateway_method.file_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = module.lambda_file_delete.invoke_arn
}
