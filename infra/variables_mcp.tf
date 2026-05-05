variable "api_bearer_token" {
  description = "Bearer token for MCP DevTools authentication"
  type        = string
  sensitive   = true
  default     = ""
}
