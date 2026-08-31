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

# Required variables (Atlas decision 0098, mantle CLI 2.12.1).
# These derive from getRequiredEnv() calls, so the generator emits them with no
# default. A plan fails unless every stage binds them.
#
# ytdlp_binary_path is live: it wires FeedlyWebhook's YTDLP_BINARY_PATH. The path
# is where docker/Dockerfile.download installs the yt-dlp binary.
ytdlp_binary_path = "/opt/bin/yt-dlp"

# The two below are required-but-inlined. Each is also set via staticEnvVars in
# the handler, so the generator writes the literal straight into the .tf and the
# variable is never referenced. The value here satisfies tofu; the runtime uses
# the inlined literal. Keep both in sync with their staticEnvVars source.
multi_authentication_path_parts = "device/register,device/event,files"
apple_app_bundle_identifier     = "lifegames.OfflineMediaDownloader"
