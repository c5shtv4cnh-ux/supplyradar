# SupplyRadar: invoice photo -> Gemini extraction -> checks -> price history -> email alerts.
#
#   Browser -> CloudFront/S3 (web app) -> API Gateway (Cognito JWT) -> api Lambda
#   api Lambda -> presigned POST -> S3 uploads -> SQS extract -> extract Lambda -> Gemini
#   extract Lambda -> SQS validate -> validate Lambda (VPC) -> DynamoDB
#   DynamoDB Streams (ALERT#) -> notify Lambda -> SNS email
#   EventBridge Scheduler (weekly) -> digest Lambda -> Gemini -> SNS email

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name         = "${var.project}-${var.environment}"
  account_id   = data.aws_caller_identity.current.account_id
  region       = data.aws_region.current.region
  backend_dir  = "${path.module}/../src/backend"
  frontend_dir = "${path.module}/../src/frontend"

  gemini_key_param = coalesce(var.gemini_key_param, "/${var.project}/${var.environment}/gemini-api-key")
  gemini_key_arn   = "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.gemini_key_param}"

  allowed_origins = concat([module.frontend.url], var.extra_allowed_origins)

  max_receive_count = 3

  api_routes = [
    "POST /uploads",
    "GET /invoices",
    "GET /invoices/{id}",
    "PUT /invoices/{id}",
    "GET /products",
    "GET /products/{key}",
    "GET /alerts",
    "GET /settings",
    "PUT /settings",
  ]

  common_env = {
    TABLE_NAME            = module.database.table_name
    UPLOAD_BUCKET         = module.storage.bucket_id
    VALIDATE_QUEUE_URL    = module.validate_queue.queue_url
    EXTRACT_QUEUE_URL     = module.extract_queue.queue_url
    ALERTS_TOPIC_ARN      = module.notifications.alerts_topic_arn
    GEMINI_KEY_PARAM      = local.gemini_key_param
    GEMINI_MODEL          = var.gemini_model
    DEFAULT_THRESHOLD_PCT = tostring(var.alert_threshold_pct)
    MAX_RECEIVES          = tostring(local.max_receive_count)
    APP_URL               = module.frontend.url
  }
}

# ---------------------------------------------------------------- network

module "network" {
  source = "./modules/network"
  name   = local.name
}

# ---------------------------------------------------------------- storage

module "storage" {
  source          = "./modules/storage"
  bucket_name     = "${local.name}-uploads-${local.account_id}"
  allowed_origins = local.allowed_origins
  retention_days  = var.upload_retention_days
  force_destroy   = !var.deletion_protection
}

module "database" {
  source              = "./modules/database"
  table_name          = local.name
  deletion_protection = var.deletion_protection
}

# ---------------------------------------------------------------- queues

module "extract_queue" {
  source                     = "./modules/queue"
  name                       = "${local.name}-extract"
  visibility_timeout_seconds = 360 # 6 x extract timeout
  max_receive_count          = local.max_receive_count
  allow_s3_source            = true
  s3_source_bucket_arn       = module.storage.bucket_arn
}

module "validate_queue" {
  source                     = "./modules/queue"
  name                       = "${local.name}-validate"
  visibility_timeout_seconds = 180 # 6 x validate timeout
  max_receive_count          = local.max_receive_count
}

resource "aws_s3_bucket_notification" "uploads" {
  bucket = module.storage.bucket_id

  queue {
    queue_arn     = module.extract_queue.queue_arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = "uploads/"
  }

  depends_on = [module.extract_queue]
}

# ---------------------------------------------------------------- auth, notifications

module "auth" {
  source              = "./modules/auth"
  name                = local.name
  deletion_protection = var.deletion_protection
}

module "notifications" {
  source              = "./modules/notifications"
  name                = local.name
  enable_digest       = true
  digest_function_arn = module.digest_fn.arn
}

# ---------------------------------------------------------------- functions

module "api_fn" {
  source             = "./modules/lambda_function"
  name               = "${local.name}-api"
  description        = "REST API: uploads, invoices, products, alerts, settings"
  source_dir         = local.backend_dir
  handler            = "api.handler"
  timeout            = 10
  environment        = local.common_env
  policy_json        = data.aws_iam_policy_document.api.json
  log_retention_days = var.log_retention_days
}

module "extract_fn" {
  source             = "./modules/lambda_function"
  name               = "${local.name}-extract"
  description        = "Reads an uploaded invoice with Gemini (outside the VPC: no NAT needed)"
  source_dir         = local.backend_dir
  handler            = "extract.handler"
  timeout            = 60
  memory_size        = 512
  environment        = local.common_env
  policy_json        = data.aws_iam_policy_document.extract.json
  log_retention_days = var.log_retention_days
}

module "validate_fn" {
  source             = "./modules/lambda_function"
  name               = "${local.name}-validate"
  description        = "Checks extracted numbers, stores prices, raises alerts (inside the VPC)"
  source_dir         = local.backend_dir
  handler            = "validate.handler"
  timeout            = 30
  environment        = local.common_env
  policy_json        = data.aws_iam_policy_document.validate.json
  log_retention_days = var.log_retention_days
  vpc_config = {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [module.network.lambda_security_group_id]
  }
}

module "notify_fn" {
  source             = "./modules/lambda_function"
  name               = "${local.name}-notify"
  description        = "Emails new price alerts through SNS"
  source_dir         = local.backend_dir
  handler            = "notify.handler"
  timeout            = 15
  environment        = local.common_env
  policy_json        = data.aws_iam_policy_document.notify.json
  log_retention_days = var.log_retention_days
}

module "digest_fn" {
  source             = "./modules/lambda_function"
  name               = "${local.name}-digest"
  description        = "Weekly plain-language summary written by Gemini"
  source_dir         = local.backend_dir
  handler            = "digest.handler"
  timeout            = 120
  environment        = local.common_env
  policy_json        = data.aws_iam_policy_document.digest.json
  log_retention_days = var.log_retention_days
}

# ---------------------------------------------------------------- triggers

resource "aws_lambda_event_source_mapping" "extract" {
  event_source_arn        = module.extract_queue.queue_arn
  function_name           = module.extract_fn.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2 # stay under the Gemini free-tier rate limit
  }
}

resource "aws_lambda_event_source_mapping" "validate" {
  event_source_arn        = module.validate_queue.queue_arn
  function_name           = module.validate_fn.arn
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_event_source_mapping" "notify" {
  event_source_arn               = module.database.stream_arn
  function_name                  = module.notify_fn.arn
  starting_position              = "LATEST"
  batch_size                     = 10
  maximum_retry_attempts         = 3
  bisect_batch_on_function_error = true
  function_response_types        = ["ReportBatchItemFailures"]

  # Only new alert items wake the function; every other write is ignored for free.
  filter_criteria {
    filter {
      pattern = jsonencode({
        eventName = ["INSERT"]
        dynamodb  = { Keys = { SK = { S = [{ prefix = "ALERT#" }] } } }
      })
    }
  }
}

# ---------------------------------------------------------------- API and web app

module "http_api" {
  source                 = "./modules/api"
  name                   = local.name
  allowed_origins        = local.allowed_origins
  jwt_issuer             = module.auth.issuer
  jwt_audience           = module.auth.client_id
  lambda_invoke_arn      = module.api_fn.invoke_arn
  lambda_function_name   = module.api_fn.function_name
  routes                 = local.api_routes
  throttling_rate_limit  = var.api_throttle_rate
  throttling_burst_limit = var.api_throttle_rate * 2
  log_retention_days     = var.log_retention_days
}

module "frontend" {
  source      = "./modules/frontend"
  bucket_name = "${local.name}-web-${local.account_id}"
  source_dir  = local.frontend_dir
  comment     = "${local.name} web app"
  app_config = {
    apiUrl      = module.http_api.api_url
    region      = local.region
    userPoolId  = module.auth.user_pool_id
    clientId    = module.auth.client_id
    environment = var.environment
  }
}

# ---------------------------------------------------------------- operations

module "monitoring" {
  source      = "./modules/monitoring"
  name        = local.name
  alarm_email = var.alarm_email
  function_names = [
    module.api_fn.function_name,
    module.extract_fn.function_name,
    module.validate_fn.function_name,
    module.notify_fn.function_name,
    module.digest_fn.function_name,
  ]
  queue_names      = [module.extract_queue.queue_name, module.validate_queue.queue_name]
  dlq_names        = [module.extract_queue.dlq_name, module.validate_queue.dlq_name]
  api_id           = module.http_api.api_id
  table_name       = module.database.table_name
  budget_limit_usd = var.budget_limit_usd
}

module "ci" {
  source            = "./modules/ci"
  count             = var.github_repository == "" ? 0 : 1
  name              = local.name
  github_repository = var.github_repository
  state_bucket      = var.state_bucket
}
