# SNS Resources (ejected from Mantle CLI — delivery status logging not supported by generator)

resource "aws_sns_topic" "push_notifications" {
  name = "${module.core.name_prefix}-PushNotifications"
  tags = module.core.common_tags
}

resource "aws_iam_role" "sns_logging" {
  name = "${module.core.name_prefix}-SNSLogging"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "sns.amazonaws.com"
      }
    }]
  })

  tags = module.core.common_tags
}

resource "aws_iam_role_policy" "sns_logging" {
  name = "SNSCloudWatchLogging"
  role = aws_iam_role.sns_logging.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:PutMetricFilter",
        "logs:PutRetentionPolicy"
      ]
      Resource = "*"
    }]
  })
}

resource "aws_sns_platform_application" "apns" {
  name                = "${module.core.name_prefix}-MediaDownloader"
  platform            = var.environment == "production" ? "APNS" : "APNS_SANDBOX"
  platform_credential = data.sops_file.secrets.data["apns.staging.privateKey"]
  platform_principal  = data.sops_file.secrets.data["apns.staging.certificate"]

  success_feedback_role_arn    = aws_iam_role.sns_logging.arn
  failure_feedback_role_arn    = aws_iam_role.sns_logging.arn
  success_feedback_sample_rate = "100"

  event_endpoint_updated_topic_arn = aws_sns_topic.endpoint_events.arn

  depends_on = [aws_iam_role.sns_logging, aws_iam_role_policy.sns_logging]
}

resource "aws_sns_topic" "endpoint_events" {
  name = "${module.core.name_prefix}-EndpointEvents"
  tags = module.core.common_tags
}
