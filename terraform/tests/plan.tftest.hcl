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
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
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
    condition     = length(local.api_routes) == 9
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
}

run "rejects_unknown_environment" {
  command = plan

  variables {
    environment = "staging"
  }

  expect_failures = [var.environment]
}
