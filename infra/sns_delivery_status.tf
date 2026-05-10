# SNS APNS Delivery Status Logging — metric filters and EndpointDisabled event handling
# Ejected: mantle generate infra does not support SNS delivery status configuration

locals {
  apns_platform = var.environment == "production" ? "APNS" : "APNS_SANDBOX"
  apns_app_name = "${module.core.name_prefix}-MediaDownloader"
  sns_log_group = "sns/${module.core.region}/${module.core.account_id}/app/${local.apns_platform}/${local.apns_app_name}"
}

# Pre-create log groups so metric filters can reference them immediately
resource "aws_cloudwatch_log_group" "sns_delivery_success" {
  name              = local.sns_log_group
  retention_in_days = var.log_retention_days
  tags              = module.core.common_tags
}

resource "aws_cloudwatch_log_group" "sns_delivery_failure" {
  name              = "${local.sns_log_group}/Failure"
  retention_in_days = var.log_retention_days
  tags              = module.core.common_tags
}

# --- CloudWatch Metric Filters ---

resource "aws_cloudwatch_log_metric_filter" "apns_handoff_success" {
  name           = "${module.core.name_prefix}-PushAPNSHandoffSuccess"
  log_group_name = aws_cloudwatch_log_group.sns_delivery_success.name
  pattern        = "{ $.status = \"SUCCESS\" }"

  metric_transformation {
    name          = "PushAPNSHandoffSuccess"
    namespace     = module.core.name_prefix
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "apns_handoff_failed" {
  name           = "${module.core.name_prefix}-PushAPNSHandoffFailed"
  log_group_name = aws_cloudwatch_log_group.sns_delivery_failure.name
  pattern        = "{ $.status = \"FAILURE\" }"

  metric_transformation {
    name          = "PushAPNSHandoffFailed"
    namespace     = module.core.name_prefix
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "apns_dwell_time" {
  name           = "${module.core.name_prefix}-PushAPNSDwellTime"
  log_group_name = aws_cloudwatch_log_group.sns_delivery_success.name
  pattern        = "{ $.dwellTimeMs >= 0 }"

  metric_transformation {
    name          = "PushAPNSDwellTime"
    namespace     = module.core.name_prefix
    value         = "$.dwellTimeMs"
    default_value = "0"
  }
}

# --- EndpointDisabled Event Handling ---
# SNS platform events → EndpointEvents SNS topic → SQS queue (module) → EndpointCleanupHelpers Lambda

resource "aws_sqs_queue_policy" "endpoint_events" {
  queue_url = module.queue_EndpointEvents.queue_url

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = module.queue_EndpointEvents.queue_arn
      Condition = {
        ArnEquals = {
          "aws:SourceArn" = aws_sns_topic.endpoint_events.arn
        }
      }
    }]
  })
}

resource "aws_sns_topic_subscription" "endpoint_events_to_sqs" {
  topic_arn = aws_sns_topic.endpoint_events.arn
  protocol  = "sqs"
  endpoint  = module.queue_EndpointEvents.queue_arn
}

# --- CloudWatch Dashboard ---

resource "aws_cloudwatch_dashboard" "push_delivery" {
  dashboard_name = "${module.core.name_prefix}-PushDelivery"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "APNS Handoff Rate"
          region = module.core.region
          metrics = [
            [module.core.name_prefix, "PushAPNSHandoffSuccess", { stat = "Sum", period = 300, label = "Success" }],
            [module.core.name_prefix, "PushAPNSHandoffFailed", { stat = "Sum", period = 300, label = "Failed" }],
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "APNS Dwell Time (ms)"
          region = module.core.region
          metrics = [
            [module.core.name_prefix, "PushAPNSDwellTime", { stat = "Average", period = 300, label = "Avg Dwell" }],
            [module.core.name_prefix, "PushAPNSDwellTime", { stat = "p99", period = 300, label = "p99 Dwell" }],
          ]
          view = "timeSeries"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Client-Side Push Confirmation"
          region = module.core.region
          metrics = [
            [module.core.name_prefix, "DeviceEventReceived", { stat = "Sum", period = 300, label = "Events Received" }],
          ]
          view = "timeSeries"
        }
      },
    ]
  })
}
