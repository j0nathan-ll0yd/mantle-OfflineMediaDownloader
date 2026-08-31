# Staging Environment Configuration
# Deploy with: tofu apply -var-file=environments/staging.tfvars
#
# Cost optimization: Staging uses minimal resources to reduce costs
# - CloudWatch dashboard disabled
# - Lower API quotas
# - No deletion protection

environment        = "staging"
resource_prefix    = "stag"
log_level          = "DEBUG"
log_retention_days = 3

# Reduced quotas for staging
api_throttle_burst_limit = 20
api_throttle_rate_limit  = 10
api_quota_limit          = 1000

# Allow destruction in staging
dsql_deletion_protection = false

# Disable metrics emission in staging (POWERTOOLS_METRICS_DISABLED)
disable_metrics = true

# Disable reserved concurrency in staging (low-quota account)
reserved_concurrency_start_file_upload = -1

# CORS: Allow Astro dashboard site to fetch media files
cors_allowed_origins = [
  "https://j0nathan-ll0yd.github.io",
  "https://jonathanlloyd.me"
]

# Required variable (Atlas decision 0098, mantle CLI 2.12.2).
# It derives from a getRequiredEnv() call, so the generator emits it with no
# default. A plan fails unless every stage binds it.
#
# ytdlp_binary_path is live: it wires FeedlyWebhook's YTDLP_BINARY_PATH. The path
# is where docker/Dockerfile.download installs the yt-dlp binary.
ytdlp_binary_path = "/opt/bin/yt-dlp"
