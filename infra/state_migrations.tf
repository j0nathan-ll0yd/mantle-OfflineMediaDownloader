# Temporary state migrations for CLI regeneration (C71)
# Remove this file after successful staging deployment

moved {
  from = aws_cloudwatch_log_group.sns_delivery_success
  to   = aws_cloudwatch_log_group.apns_delivery_success
}

moved {
  from = aws_cloudwatch_log_group.sns_delivery_failure
  to   = aws_cloudwatch_log_group.apns_delivery_failure
}

moved {
  from = aws_cloudfront_function.api_key_promotion
  to   = aws_cloudfront_function.api_function
}
