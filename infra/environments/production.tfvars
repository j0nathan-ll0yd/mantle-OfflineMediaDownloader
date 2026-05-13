# Production Environment Configuration
# Deploy with: tofu apply -var-file=environments/production.tfvars
#
# Full production settings with monitoring and protection enabled

environment        = "prod"
resource_prefix    = "prod"
log_level          = "INFO"
log_retention_days = 7

# Full quotas for production
api_throttle_burst_limit = 100
api_throttle_rate_limit  = 50
api_quota_limit          = 10000

# Protect production data
dsql_deletion_protection = true

# Disable custom CloudWatch metrics to stay within AWS Free Tier
disable_metrics = true

# Production concurrency
reserved_concurrency_start_file_upload = 10

# CORS: Allow Astro dashboard site to fetch media files
cors_allowed_origins = [
  "https://j0nathan-ll0yd.github.io",
  "https://jonathanlloyd.me"
]
