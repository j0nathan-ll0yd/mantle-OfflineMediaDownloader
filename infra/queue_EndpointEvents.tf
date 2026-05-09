# SQS queue: EndpointEvents — receives SNS platform endpoint lifecycle events
module "queue_EndpointEvents" {
  source           = "../../mantle/modules/queue"
  queue_name       = "EndpointEvents"
  name_prefix      = module.core.name_prefix
  tags                       = module.core.common_tags
  enable_dlq_alarm           = false
  visibility_timeout_seconds = 180
}
