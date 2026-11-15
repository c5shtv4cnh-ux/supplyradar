# Offline test of the whole stack: `terraform test` plans every module against a
# mocked AWS provider (no credentials, no cost) and checks key design rules.
#   cd terraform && terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-central-1" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-central-1a", "eu-central-1b", "eu-central-1c"] }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

# The us-east-1 alias is used only by the optional WAF module.
mock_provider "aws" {
  alias = "us_east_1"
}

mock_provider "archive" {}

variables {
  environment = "dev"
  alarm_email = "owner@example.com"
}

run "dev_plan" {
  command = plan

  assert {
    condition     = length(module.network.private_subnet_ids) == 2
    error_message = "Expected two private subnets."
  }

  assert {
    condition     = local.gemini_key_param == "/supplyradar/dev/gemini-api-key"
    error_message = "Gemini key parameter name is wrong."
  }

  assert {
    condition     = module.validate_fn.function_name == "supplyradar-dev-validate"
    error_message = "Function naming changed."
  }

  assert {
    condition     = length(local.api_routes) == 39
    error_message = "Every API route must be declared."
  }

  assert {
    condition     = aws_lambda_event_source_mapping.extract.scaling_config[0].maximum_concurrency == 2
    error_message = "Extract concurrency must stay low for the Gemini free tier."
  }

  assert {
    condition     = length(module.ci) == 0
    error_message = "CI role must be optional."
  }

  # Paid features stay off unless asked for.
  assert {
    condition     = length(module.waf) == 0 && length(module.kms) == 0
    error_message = "WAF and the customer-managed KMS key must be off by default (they cost money)."
  }

  assert {
    condition     = module.frontend.web_acl_arn == null
    error_message = "No web ACL expected without enable_waf."
  }

  # Free protection is on by default.
  assert {
    condition     = module.database.point_in_time_recovery_enabled
    error_message = "DynamoDB point-in-time recovery must be on by default."
  }

  assert {
    condition     = alltrue([for f in [module.api_fn, module.extract_fn, module.validate_fn, module.notify_fn, module.digest_fn] : f.tracing_mode == "Active"])
    error_message = "X-Ray tracing must be on for every function by default."
  }

  assert {
    condition     = length(module.monitoring.alarm_names) == 10
    error_message = "Exactly 10 alarms: that is what the CloudWatch free tier covers."
  }

  assert {
    condition     = strcontains(local.content_security_policy, "frame-ancestors 'none'") && strcontains(local.content_security_policy, "script-src 'self'")
    error_message = "The Content-Security-Policy must forbid framing and third-party scripts."
  }

  assert {
    condition     = module.http_api.route_throttles["POST /assistant"].rate < var.api_throttle_rate
    error_message = "The Gemini assistant route must have a tighter limit than the default."
  }
}

run "prod_plan" {
  command = plan

  variables {
    environment         = "prod"
    deletion_protection = true
    github_repository   = "student/supplyradar"
    state_bucket        = "supplyradar-tfstate-123456789012"
  }

  assert {
    condition     = length(module.ci) == 1
    error_message = "CI role expected when github_repository is set."
  }

  assert {
    condition     = module.ci[0].deploy_role_name == null
    error_message = "The deploy role must not exist unless enable_github_deploy is set."
  }

  assert {
    condition     = module.database.point_in_time_recovery_enabled && module.database.deletion_protection_enabled
    error_message = "Prod table must have backups and deletion protection."
  }
}

# Everything that costs money switched on, plus the deploy role for a second
# environment in the same account (the OIDC provider already exists).
run "prod_hardened" {
  command = plan

  variables {
    environment                 = "prod"
    deletion_protection         = true
    enable_waf                  = true
    enable_kms                  = true
    upload_versioning           = true
    table_billing_mode          = "PAY_PER_REQUEST"
    github_repository           = "student/supplyradar"
    state_bucket                = "supplyradar-tfstate-123456789012"
    enable_github_deploy        = true
    create_github_oidc_provider = false
  }

  assert {
    condition     = length(module.waf) == 1 && length(module.kms) == 1
    error_message = "WAF and KMS expected when enabled."
  }

  assert {
    condition     = module.ci[0].deploy_role_name == "supplyradar-prod-github-deploy"
    error_message = "Deploy role expected with enable_github_deploy."
  }

  assert {
    condition     = module.ci[0].creates_oidc_provider == false
    error_message = "The second environment must reuse the account's OIDC provider."
  }

  assert {
    condition     = module.database.billing_mode == "PAY_PER_REQUEST"
    error_message = "On-demand billing expected."
  }

  assert {
    condition     = module.storage.versioning_status == "Enabled"
    error_message = "Upload versioning expected."
  }
}

# The gotcha that once replaced the alarm subscription: a missing or
# placeholder owner email must stop the plan.
run "rejects_placeholder_email" {
  command = plan

  variables {
    alarm_email = "you@example.com"
  }

  expect_failures = [var.alarm_email]
}

run "rejects_missing_email" {
  command = plan

  variables {
    alarm_email = ""
  }

  expect_failures = [var.alarm_email]
}

run "rejects_throttle_for_unknown_route" {
  command = plan

  variables {
    api_route_throttles = {
      "POST /no-such-route" = { rate = 1, burst = 1 }
    }
  }

  expect_failures = [var.api_route_throttles]
}

run "rejects_unknown_environment" {
  command = plan

  variables {
    environment = "staging"
  }

  expect_failures = [var.environment]
}
