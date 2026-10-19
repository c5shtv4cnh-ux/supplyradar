output "app_url" {
  description = "Public URL of the web app."
  value       = module.frontend.url
}

output "api_url" {
  value = module.http_api.api_url
}

output "user_pool_id" {
  value = module.auth.user_pool_id
}

output "user_pool_client_id" {
  value = module.auth.client_id
}

output "upload_bucket" {
  value = module.storage.bucket_id
}

output "table_name" {
  value = module.database.table_name
}

output "gemini_key_param" {
  description = "Store the Gemini API key here (see docs/setup-guide.md)."
  value       = local.gemini_key_param
}

output "function_names" {
  value = {
    api      = module.api_fn.function_name
    extract  = module.extract_fn.function_name
    validate = module.validate_fn.function_name
    notify   = module.notify_fn.function_name
    digest   = module.digest_fn.function_name
  }
}

output "dashboard_url" {
  value = "https://${local.region}.console.aws.amazon.com/cloudwatch/home?region=${local.region}#dashboards/dashboard/${module.monitoring.dashboard_name}"
}

output "cloudfront_distribution_id" {
  value = module.frontend.distribution_id
}

output "github_plan_role_arn" {
  value = try(module.ci[0].role_arn, null)
}
