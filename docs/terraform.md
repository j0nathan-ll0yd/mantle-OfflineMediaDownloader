## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.11.0 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 5.0 |
| <a name="requirement_sops"></a> [sops](#requirement\_sops) | >= 1.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_archive"></a> [archive](#provider\_archive) | 2.7.1 |
| <a name="provider_aws"></a> [aws](#provider\_aws) | 6.37.0 |
| <a name="provider_sops"></a> [sops](#provider\_sops) | 1.4.1 |
| <a name="provider_terraform"></a> [terraform](#provider\_terraform) | n/a |
| <a name="provider_time"></a> [time](#provider\_time) | 0.13.1 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_api"></a> [api](#module\_api) | ../../../Repositories/mantle/modules/api-gateway | n/a |
| <a name="module_core"></a> [core](#module\_core) | ../../../Repositories/mantle/modules/core | n/a |
| <a name="module_database"></a> [database](#module\_database) | ../../../Repositories/mantle/modules/database/aurora-dsql | n/a |
| <a name="module_dynamodb_idempotency"></a> [dynamodb\_idempotency](#module\_dynamodb\_idempotency) | ../../../Repositories/mantle/modules/dynamodb | n/a |
| <a name="module_eventbridge"></a> [eventbridge](#module\_eventbridge) | ../../../Repositories/mantle/modules/eventbridge | n/a |
| <a name="module_lambda_api_gateway_authorizer"></a> [lambda\_api\_gateway\_authorizer](#module\_lambda\_api\_gateway\_authorizer) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_cleanup_expired_records"></a> [lambda\_cleanup\_expired\_records](#module\_lambda\_cleanup\_expired\_records) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_dev_tools"></a> [lambda\_dev\_tools](#module\_lambda\_dev\_tools) | ../../mantle/modules/lambda | n/a |
| <a name="module_lambda_device_event"></a> [lambda\_device\_event](#module\_lambda\_device\_event) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_device_register"></a> [lambda\_device\_register](#module\_lambda\_device\_register) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_download_orchestrator"></a> [lambda\_download\_orchestrator](#module\_lambda\_download\_orchestrator) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_endpoint_cleanup_helpers"></a> [lambda\_endpoint\_cleanup\_helpers](#module\_lambda\_endpoint\_cleanup\_helpers) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_failure_handler"></a> [lambda\_failure\_handler](#module\_lambda\_failure\_handler) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_feedly_webhook"></a> [lambda\_feedly\_webhook](#module\_lambda\_feedly\_webhook) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_file_helpers"></a> [lambda\_file\_helpers](#module\_lambda\_file\_helpers) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_files_by_id_delete"></a> [lambda\_files\_by\_id\_delete](#module\_lambda\_files\_by\_id\_delete) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_files_get"></a> [lambda\_files\_get](#module\_lambda\_files\_get) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_helpers"></a> [lambda\_helpers](#module\_lambda\_helpers) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_migrate_dsql"></a> [lambda\_migrate\_dsql](#module\_lambda\_migrate\_dsql) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_prune_devices"></a> [lambda\_prune\_devices](#module\_lambda\_prune\_devices) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_push_helpers"></a> [lambda\_push\_helpers](#module\_lambda\_push\_helpers) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_s3object_created"></a> [lambda\_s3object\_created](#module\_lambda\_s3object\_created) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_s3recovery"></a> [lambda\_s3recovery](#module\_lambda\_s3recovery) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_send_push_notification"></a> [lambda\_send\_push\_notification](#module\_lambda\_send\_push\_notification) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_start_file_upload"></a> [lambda\_start\_file\_upload](#module\_lambda\_start\_file\_upload) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_user_delete"></a> [lambda\_user\_delete](#module\_lambda\_user\_delete) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_user_login"></a> [lambda\_user\_login](#module\_lambda\_user\_login) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_user_logout"></a> [lambda\_user\_logout](#module\_lambda\_user\_logout) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_user_refresh"></a> [lambda\_user\_refresh](#module\_lambda\_user\_refresh) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_user_register"></a> [lambda\_user\_register](#module\_lambda\_user\_register) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_lambda_user_subscribe"></a> [lambda\_user\_subscribe](#module\_lambda\_user\_subscribe) | ../../../Repositories/mantle/modules/lambda | n/a |
| <a name="module_queue_DownloadQueue"></a> [queue\_DownloadQueue](#module\_queue\_DownloadQueue) | ../../mantle/modules/queue | n/a |
| <a name="module_queue_EndpointEvents"></a> [queue\_EndpointEvents](#module\_queue\_EndpointEvents) | ../../mantle/modules/queue | n/a |
| <a name="module_queue_SendPushNotification"></a> [queue\_SendPushNotification](#module\_queue\_SendPushNotification) | ../../mantle/modules/queue | n/a |
| <a name="module_storage_files"></a> [storage\_files](#module\_storage\_files) | ../../../Repositories/mantle/modules/storage | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [aws_api_gateway_integration.device_event](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.device_register](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.feedly_webhook](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.files_by_id_delete](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.files_get](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.user_delete](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.user_login](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.user_logout](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.user_refresh](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.user_register](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_integration.user_subscribe](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_integration) | resource |
| [aws_api_gateway_method.device_event](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.device_register](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.feedly_webhook](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.files_by_id_delete](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.files_get](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.user_delete](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.user_login](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.user_logout](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.user_refresh](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.user_register](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_method.user_subscribe](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_method) | resource |
| [aws_api_gateway_resource.device_event](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.device_register](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.feedly_webhook](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.path_device](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.path_feedly](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.path_files](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.path_files_file_id](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.path_user](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.user_login](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.user_logout](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.user_refresh](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.user_register](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_api_gateway_resource.user_subscribe](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/api_gateway_resource) | resource |
| [aws_cloudfront_distribution.api](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudfront_distribution) | resource |
| [aws_cloudfront_function.api_key_promotion](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudfront_function) | resource |
| [aws_cloudwatch_dashboard.push_delivery](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_dashboard) | resource |
| [aws_cloudwatch_event_rule.download_requested](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_rule) | resource |
| [aws_cloudwatch_event_target.download_requested_to_sqs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_target) | resource |
| [aws_cloudwatch_log_group.sns_delivery_failure](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_cloudwatch_log_group.sns_delivery_success](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_cloudwatch_log_metric_filter.apns_dwell_time](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_metric_filter) | resource |
| [aws_cloudwatch_log_metric_filter.apns_handoff_failed](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_metric_filter) | resource |
| [aws_cloudwatch_log_metric_filter.apns_handoff_success](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_metric_filter) | resource |
| [aws_ecr_lifecycle_policy.start_file_upload](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecr_lifecycle_policy) | resource |
| [aws_ecr_repository.start_file_upload](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecr_repository) | resource |
| [aws_iam_role.sns_logging](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role_policy.sns_logging](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_lambda_layer_version.bgutil](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_layer_version) | resource |
| [aws_lambda_layer_version.ffmpeg](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_layer_version) | resource |
| [aws_lambda_layer_version.yt_dlp](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_layer_version) | resource |
| [aws_s3_object.asset_videos_default_file](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_object) | resource |
| [aws_sns_platform_application.apns](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sns_platform_application) | resource |
| [aws_sns_topic.endpoint_events](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sns_topic) | resource |
| [aws_sns_topic.push_notifications](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sns_topic) | resource |
| [aws_sns_topic_subscription.endpoint_events_to_sqs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sns_topic_subscription) | resource |
| [aws_sqs_queue_policy.download_queue_eventbridge](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_policy) | resource |
| [aws_sqs_queue_policy.endpoint_events](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_policy) | resource |
| [terraform_data.rerun_migration](https://registry.terraform.io/providers/hashicorp/terraform/latest/docs/resources/data) | resource |
| [time_sleep.wait_for_dsql](https://registry.terraform.io/providers/hashicorp/time/latest/docs/resources/sleep) | resource |
| [archive_file.layer_bgutil](https://registry.terraform.io/providers/hashicorp/archive/latest/docs/data-sources/file) | data source |
| [archive_file.layer_ffmpeg](https://registry.terraform.io/providers/hashicorp/archive/latest/docs/data-sources/file) | data source |
| [archive_file.layer_yt_dlp](https://registry.terraform.io/providers/hashicorp/archive/latest/docs/data-sources/file) | data source |
| [aws_lambda_invocation.run_migration](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/lambda_invocation) | data source |
| [sops_file.secrets](https://registry.terraform.io/providers/carlpett/sops/latest/docs/data-sources/file) | data source |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_api_bearer_token"></a> [api\_bearer\_token](#input\_api\_bearer\_token) | Bearer token for MCP DevTools authentication | `string` | `""` | no |
| <a name="input_api_quota_limit"></a> [api\_quota\_limit](#input\_api\_quota\_limit) | API Gateway daily quota limit | `number` | `10000` | no |
| <a name="input_api_throttle_burst_limit"></a> [api\_throttle\_burst\_limit](#input\_api\_throttle\_burst\_limit) | API Gateway throttle burst limit | `number` | `100` | no |
| <a name="input_api_throttle_rate_limit"></a> [api\_throttle\_rate\_limit](#input\_api\_throttle\_rate\_limit) | API Gateway throttle rate limit | `number` | `50` | no |
| <a name="input_apns_default_topic"></a> [apns\_default\_topic](#input\_apns\_default\_topic) | apns default topic | `string` | `""` | no |
| <a name="input_apns_host"></a> [apns\_host](#input\_apns\_host) | apns host | `string` | `""` | no |
| <a name="input_apns_key_id"></a> [apns\_key\_id](#input\_apns\_key\_id) | apns key id | `string` | `""` | no |
| <a name="input_apns_signing_key"></a> [apns\_signing\_key](#input\_apns\_signing\_key) | apns signing key | `string` | `""` | no |
| <a name="input_apns_team"></a> [apns\_team](#input\_apns\_team) | apns team | `string` | `""` | no |
| <a name="input_apple_app_bundle_identifier"></a> [apple\_app\_bundle\_identifier](#input\_apple\_app\_bundle\_identifier) | apple app bundle identifier | `string` | `""` | no |
| <a name="input_apple_client_id"></a> [apple\_client\_id](#input\_apple\_client\_id) | apple client id | `string` | `""` | no |
| <a name="input_apple_client_secret"></a> [apple\_client\_secret](#input\_apple\_client\_secret) | apple client secret | `string` | `""` | no |
| <a name="input_auth_secret"></a> [auth\_secret](#input\_auth\_secret) | auth secret | `string` | `""` | no |
| <a name="input_aws_region"></a> [aws\_region](#input\_aws\_region) | AWS region | `string` | `"us-west-2"` | no |
| <a name="input_cors_allowed_origins"></a> [cors\_allowed\_origins](#input\_cors\_allowed\_origins) | Origins allowed to fetch media files via CORS (empty list disables CORS) | `list(string)` | `[]` | no |
| <a name="input_data_bucket"></a> [data\_bucket](#input\_data\_bucket) | data bucket | `string` | `""` | no |
| <a name="input_disable_metrics"></a> [disable\_metrics](#input\_disable\_metrics) | Disable CloudWatch custom metrics emission (sets POWERTOOLS\_METRICS\_DISABLED) | `bool` | `false` | no |
| <a name="input_dsql_deletion_protection"></a> [dsql\_deletion\_protection](#input\_dsql\_deletion\_protection) | Enable deletion protection for DSQL cluster | `bool` | `true` | no |
| <a name="input_dsql_endpoint"></a> [dsql\_endpoint](#input\_dsql\_endpoint) | Aurora DSQL cluster endpoint (set after initial provisioning or pass from database module) | `string` | `""` | no |
| <a name="input_environment"></a> [environment](#input\_environment) | Deployment environment | `string` | `"dev"` | no |
| <a name="input_github_personal_token"></a> [github\_personal\_token](#input\_github\_personal\_token) | github personal token | `string` | `""` | no |
| <a name="input_image_uri_start_file_upload"></a> [image\_uri\_start\_file\_upload](#input\_image\_uri\_start\_file\_upload) | ECR image URI for StartFileUpload container Lambda | `string` | `""` | no |
| <a name="input_log_level"></a> [log\_level](#input\_log\_level) | Application log level (DEBUG, INFO, WARN, ERROR) | `string` | `"INFO"` | no |
| <a name="input_log_retention_days"></a> [log\_retention\_days](#input\_log\_retention\_days) | CloudWatch log retention in days | `number` | `14` | no |
| <a name="input_multi_authentication_path_parts"></a> [multi\_authentication\_path\_parts](#input\_multi\_authentication\_path\_parts) | multi authentication path parts | `string` | `""` | no |
| <a name="input_node_env"></a> [node\_env](#input\_node\_env) | node env | `string` | `""` | no |
| <a name="input_path"></a> [path](#input\_path) | path | `string` | `""` | no |
| <a name="input_project_name"></a> [project\_name](#input\_project\_name) | Project name | `string` | `"media-downloader"` | no |
| <a name="input_reserved_client_ip"></a> [reserved\_client\_ip](#input\_reserved\_client\_ip) | reserved client ip | `string` | `""` | no |
| <a name="input_reserved_concurrency_start_file_upload"></a> [reserved\_concurrency\_start\_file\_upload](#input\_reserved\_concurrency\_start\_file\_upload) | Reserved concurrent executions for StartFileUpload Lambda (-1 for unreserved) | `number` | `1` | no |
| <a name="input_resource_prefix"></a> [resource\_prefix](#input\_resource\_prefix) | DEPRECATED: Legacy prefix for S3 bucket names only. New resources use module.core.name\_prefix. Do not replicate in new instances. See ADR 0001. | `string` | n/a | yes |
| <a name="input_ytdlp_binary_path"></a> [ytdlp\_binary\_path](#input\_ytdlp\_binary\_path) | ytdlp binary path | `string` | `""` | no |
| <a name="input_ytdlp_max_sleep_interval"></a> [ytdlp\_max\_sleep\_interval](#input\_ytdlp\_max\_sleep\_interval) | ytdlp max sleep interval | `string` | `""` | no |
| <a name="input_ytdlp_sleep_interval"></a> [ytdlp\_sleep\_interval](#input\_ytdlp\_sleep\_interval) | ytdlp sleep interval | `string` | `""` | no |
| <a name="input_ytdlp_sleep_requests"></a> [ytdlp\_sleep\_requests](#input\_ytdlp\_sleep\_requests) | ytdlp sleep requests | `string` | `""` | no |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_api_gateway_authorizer_function_arn"></a> [api\_gateway\_authorizer\_function\_arn](#output\_api\_gateway\_authorizer\_function\_arn) | ARN of the ApiGatewayAuthorizer Lambda function |
| <a name="output_api_key"></a> [api\_key](#output\_api\_key) | API key value |
| <a name="output_api_url"></a> [api\_url](#output\_api\_url) | API Gateway invoke URL |
| <a name="output_cleanup_expired_records_function_arn"></a> [cleanup\_expired\_records\_function\_arn](#output\_cleanup\_expired\_records\_function\_arn) | ARN of the CleanupExpiredRecords Lambda function |
| <a name="output_database_endpoint"></a> [database\_endpoint](#output\_database\_endpoint) | Database cluster endpoint |
| <a name="output_dev_tools_function_arn"></a> [dev\_tools\_function\_arn](#output\_dev\_tools\_function\_arn) | ARN of the DevTools Lambda function |
| <a name="output_device_event_function_arn"></a> [device\_event\_function\_arn](#output\_device\_event\_function\_arn) | ARN of the DeviceEvent Lambda function |
| <a name="output_device_register_function_arn"></a> [device\_register\_function\_arn](#output\_device\_register\_function\_arn) | ARN of the DeviceRegister Lambda function |
| <a name="output_download_orchestrator_function_arn"></a> [download\_orchestrator\_function\_arn](#output\_download\_orchestrator\_function\_arn) | ARN of the DownloadOrchestrator Lambda function |
| <a name="output_dynamodb_idempotency_table_arn"></a> [dynamodb\_idempotency\_table\_arn](#output\_dynamodb\_idempotency\_table\_arn) | DynamoDB table ARN for idempotency |
| <a name="output_dynamodb_idempotency_table_name"></a> [dynamodb\_idempotency\_table\_name](#output\_dynamodb\_idempotency\_table\_name) | DynamoDB table name for idempotency |
| <a name="output_endpoint_cleanup_helpers_function_arn"></a> [endpoint\_cleanup\_helpers\_function\_arn](#output\_endpoint\_cleanup\_helpers\_function\_arn) | ARN of the EndpointCleanupHelpers Lambda function |
| <a name="output_eventbridge_bus_arn"></a> [eventbridge\_bus\_arn](#output\_eventbridge\_bus\_arn) | EventBridge bus ARN |
| <a name="output_eventbridge_bus_name"></a> [eventbridge\_bus\_name](#output\_eventbridge\_bus\_name) | EventBridge bus name |
| <a name="output_eventbridge_dlq_arn"></a> [eventbridge\_dlq\_arn](#output\_eventbridge\_dlq\_arn) | EventBridge DLQ ARN |
| <a name="output_failure_handler_function_arn"></a> [failure\_handler\_function\_arn](#output\_failure\_handler\_function\_arn) | ARN of the FailureHandler Lambda function |
| <a name="output_feedly_webhook_function_arn"></a> [feedly\_webhook\_function\_arn](#output\_feedly\_webhook\_function\_arn) | ARN of the FeedlyWebhook Lambda function |
| <a name="output_file_helpers_function_arn"></a> [file\_helpers\_function\_arn](#output\_file\_helpers\_function\_arn) | ARN of the FileHelpers Lambda function |
| <a name="output_files_by_id_delete_function_arn"></a> [files\_by\_id\_delete\_function\_arn](#output\_files\_by\_id\_delete\_function\_arn) | ARN of the FilesByIdDelete Lambda function |
| <a name="output_files_get_function_arn"></a> [files\_get\_function\_arn](#output\_files\_get\_function\_arn) | ARN of the FilesGet Lambda function |
| <a name="output_helpers_function_arn"></a> [helpers\_function\_arn](#output\_helpers\_function\_arn) | ARN of the Helpers Lambda function |
| <a name="output_migrate_dsql_function_arn"></a> [migrate\_dsql\_function\_arn](#output\_migrate\_dsql\_function\_arn) | ARN of the MigrateDSQL Lambda function |
| <a name="output_migration_result"></a> [migration\_result](#output\_migration\_result) | n/a |
| <a name="output_prune_devices_function_arn"></a> [prune\_devices\_function\_arn](#output\_prune\_devices\_function\_arn) | ARN of the PruneDevices Lambda function |
| <a name="output_push_helpers_function_arn"></a> [push\_helpers\_function\_arn](#output\_push\_helpers\_function\_arn) | ARN of the PushHelpers Lambda function |
| <a name="output_queue_DownloadQueue_arn"></a> [queue\_DownloadQueue\_arn](#output\_queue\_DownloadQueue\_arn) | SQS queue ARN for DownloadQueue |
| <a name="output_queue_DownloadQueue_url"></a> [queue\_DownloadQueue\_url](#output\_queue\_DownloadQueue\_url) | SQS queue URL for DownloadQueue |
| <a name="output_queue_SendPushNotification_arn"></a> [queue\_SendPushNotification\_arn](#output\_queue\_SendPushNotification\_arn) | SQS queue ARN for SendPushNotification |
| <a name="output_queue_SendPushNotification_url"></a> [queue\_SendPushNotification\_url](#output\_queue\_SendPushNotification\_url) | SQS queue URL for SendPushNotification |
| <a name="output_s3object_created_function_arn"></a> [s3object\_created\_function\_arn](#output\_s3object\_created\_function\_arn) | ARN of the S3ObjectCreated Lambda function |
| <a name="output_s3recovery_function_arn"></a> [s3recovery\_function\_arn](#output\_s3recovery\_function\_arn) | ARN of the S3Recovery Lambda function |
| <a name="output_send_push_notification_function_arn"></a> [send\_push\_notification\_function\_arn](#output\_send\_push\_notification\_function\_arn) | ARN of the SendPushNotification Lambda function |
| <a name="output_start_file_upload_function_arn"></a> [start\_file\_upload\_function\_arn](#output\_start\_file\_upload\_function\_arn) | ARN of the StartFileUpload Lambda function |
| <a name="output_storage_files_bucket_arn"></a> [storage\_files\_bucket\_arn](#output\_storage\_files\_bucket\_arn) | ARN of the files S3 bucket |
| <a name="output_storage_files_cloudfront_domain"></a> [storage\_files\_cloudfront\_domain](#output\_storage\_files\_cloudfront\_domain) | CloudFront domain for files |
| <a name="output_user_delete_function_arn"></a> [user\_delete\_function\_arn](#output\_user\_delete\_function\_arn) | ARN of the UserDelete Lambda function |
| <a name="output_user_login_function_arn"></a> [user\_login\_function\_arn](#output\_user\_login\_function\_arn) | ARN of the UserLogin Lambda function |
| <a name="output_user_logout_function_arn"></a> [user\_logout\_function\_arn](#output\_user\_logout\_function\_arn) | ARN of the UserLogout Lambda function |
| <a name="output_user_refresh_function_arn"></a> [user\_refresh\_function\_arn](#output\_user\_refresh\_function\_arn) | ARN of the UserRefresh Lambda function |
| <a name="output_user_register_function_arn"></a> [user\_register\_function\_arn](#output\_user\_register\_function\_arn) | ARN of the UserRegister Lambda function |
| <a name="output_user_subscribe_function_arn"></a> [user\_subscribe\_function\_arn](#output\_user\_subscribe\_function\_arn) | ARN of the UserSubscribe Lambda function |
