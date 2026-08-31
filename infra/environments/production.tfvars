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

# Required variables (Atlas decision 0098, mantle CLI 2.12.1).
# These derive from getRequiredEnv() calls, so the generator emits them with no
# default. A plan fails unless every stage binds them.
#
# All three match staging. They are stage-independent: the yt-dlp path is baked
# into the container image, the authorizer path parts are the same API routes,
# and the iOS app ships a single bundle identifier for every stage.
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
