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

  kms_key_arn = var.enable_kms ? module.kms[0].key_arn : null

  # Browser allow-list for the web app. The API host is a wildcard on purpose:
  # the exact API id is not known before the distribution exists (the API's
  # CORS setting needs the CloudFront URL first).
  uploads_bucket_name = "${local.name}-uploads-${local.account_id}"
  uploads_origin      = "https://${local.uploads_bucket_name}.s3.${local.region}.amazonaws.com"
  content_security_policy = join("; ", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: ${local.uploads_origin}",
    "font-src 'self'",
    "connect-src 'self' https://*.execute-api.${local.region}.amazonaws.com https://cognito-idp.${local.region}.amazonaws.com ${local.uploads_origin}",
    "form-action 'self' ${local.uploads_origin}",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ])

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
    "GET /admin/overview",
    "GET /suppliers",
    "GET /suppliers/{id}",
    "GET /catalog",
    "POST /catalog",
    "PUT /catalog/{id}",
    "DELETE /catalog/{id}",
    "GET /orders",
    "POST /orders",
    "PUT /orders/{id}",
    "GET /subscription",
    "POST /subscription",
    "POST /assistant",
    "GET /savings",
    "GET /recipes",
    "POST /recipes",
    "PUT /recipes/{id}",
    "DELETE /recipes/{id}",
    "GET /locations",
    "POST /locations",
    "PUT /locations/{id}",
    "DELETE /locations/{id}",
    "GET /contracts",
    "PUT /contracts",
    "DELETE /contracts/{id}",
    "GET /claims",
    "POST /claims",
    "PUT /claims/{id}",
    "POST /demo",
    "DELETE /demo",
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
    ADMIN_EMAILS          = var.admin_emails != "" ? var.admin_emails : var.alarm_email
  }
}

# ---------------------------------------------------------------- network

module "network" {
  source = "./modules/network"
  name   = local.name
}

# ---------------------------------------------------------------- encryption, firewall (both optional, both cost money)

module "kms" {
  source = "./modules/kms"
  count  = var.enable_kms ? 1 : 0
  name   = local.name
}

module "waf" {
  source     = "./modules/waf"
  count      = var.enable_waf ? 1 : 0
  name       = local.name
  rate_limit = var.waf_rate_limit

  providers = {
    aws = aws.us_east_1
  }
}

# ---------------------------------------------------------------- storage

module "storage" {
  source             = "./modules/storage"
  bucket_name        = local.uploads_bucket_name
  allowed_origins    = local.allowed_origins
  retention_days     = var.upload_retention_days
  ia_transition_days = var.upload_ia_transition_days
  versioning         = var.upload_versioning
  kms_key_arn        = local.kms_key_arn
  force_destroy      = !var.deletion_protection
}

module "database" {
  source                 = "./modules/database"
  table_name             = local.name
  billing_mode           = var.table_billing_mode
  point_in_time_recovery = var.enable_point_in_time_recovery
  kms_key_arn            = local.kms_key_arn
  deletion_protection    = var.deletion_protection
}

# ---------------------------------------------------------------- queues

module "extract_queue" {
  source                     = "./modules/queue"
  name                       = "${local.name}-extract"
  visibility_timeout_seconds = 360 # 6 x extract timeout
  max_receive_count          = local.max_receive_count
  allow_s3_source            = true
  s3_source_bucket_arn       = module.storage.bucket_arn
  kms_key_id                 = local.kms_key_arn
}

module "validate_queue" {
  source                     = "./modules/queue"
  name                       = "${local.name}-validate"
  visibility_timeout_seconds = 180 # 6 x validate timeout
  max_receive_count          = local.max_receive_count
  kms_key_id                 = local.kms_key_arn
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
  description        = "REST API: uploads, invoices, products, alerts, settings, suppliers, orders, plans, assistant, recipes"
  source_dir         = local.backend_dir
  handler            = "api.handler"
  timeout            = 30 # the assistant waits for Gemini
  environment        = local.common_env
  policy_json        = data.aws_iam_policy_document.api.json
  log_retention_days = var.log_retention_days
  tracing            = var.enable_xray
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
  tracing            = var.enable_xray
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
  tracing            = var.enable_xray
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
  tracing            = var.enable_xray
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
  tracing            = var.enable_xray
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
  route_throttles        = var.api_route_throttles
  log_retention_days     = var.log_retention_days
}

module "frontend" {
  source      = "./modules/frontend"
  bucket_name = "${local.name}-web-${local.account_id}"
  source_dir  = local.frontend_dir
  comment     = "${local.name} web app"
  web_acl_arn = var.enable_waf ? module.waf[0].web_acl_arn : null
  versioning  = var.web_versioning

  content_security_policy = var.enable_csp ? local.content_security_policy : ""

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
  log_group_names = {
    api      = module.api_fn.log_group_name
    extract  = module.extract_fn.log_group_name
    validate = module.validate_fn.log_group_name
    notify   = module.notify_fn.log_group_name
    digest   = module.digest_fn.log_group_name
  }
  queue_names        = [module.extract_queue.queue_name, module.validate_queue.queue_name]
  dlq_names          = [module.extract_queue.dlq_name, module.validate_queue.dlq_name]
  api_id             = module.http_api.api_id
  api_log_group_name = module.http_api.access_log_group_name
  table_name         = module.database.table_name
  distribution_id    = module.frontend.distribution_id
  web_acl_name       = var.enable_waf ? module.waf[0].web_acl_name : null
  budget_limit_usd   = var.budget_limit_usd
}

# GitHub Actions roles. Created only when github_repository is set; the
# workflows stay skipped until the owner saves the role ARNs in GitHub.
module "ci" {
  source                   = "./modules/ci"
  count                    = var.github_repository == "" ? 0 : 1
  name                     = local.name
  github_repository        = var.github_repository
  github_environment       = var.environment
  state_bucket             = var.state_bucket
  state_key_prefix         = "${var.project}/${var.environment}"
  protected_state_prefixes = [for e in ["dev", "prod"] : "${var.project}/${e}" if e != var.environment]
  create_oidc_provider     = var.create_github_oidc_provider
  create_deploy_role       = var.enable_github_deploy
  uploads_bucket_arn       = module.storage.bucket_arn
}
