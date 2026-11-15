# Operations: alarms, one dashboard, saved log queries and a monthly budget.
# Alarms email the project owner through an ops topic.
#
# The module creates exactly 10 alarms and 3 custom metrics, which is what the
# CloudWatch free tier covers (10 alarms, 10 custom metrics, 3 dashboards).

data "aws_region" "current" {}

locals {
  region    = data.aws_region.current.region
  namespace = "SupplyRadar/${var.name}"
  fn_short  = { for f in var.function_names : f => trimprefix(f, "${var.name}-") }
}

resource "aws_sns_topic" "ops" {
  name = "${var.name}-ops"
}

resource "aws_sns_topic_subscription" "ops_email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# ---------------------------------------------------------------- metrics from logs
#
# The queue workers catch their own exceptions (so one bad message does not
# fail the whole batch), which means the built-in Lambda "Errors" metric stays
# at zero for them. These filters turn the log lines into metrics instead.

resource "aws_cloudwatch_log_metric_filter" "handled_errors" {
  for_each       = var.log_group_names
  name           = "${var.name}-${each.key}-logged-errors"
  log_group_name = each.value
  pattern        = "?\"[ERROR]\" ?\"Task timed out\""

  metric_transformation {
    namespace     = local.namespace
    name          = "LoggedErrors"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Live AI quality signal: how many invoices passed the checks on their own
# and how many needed a person.
resource "aws_cloudwatch_log_metric_filter" "invoices_checked" {
  count          = contains(keys(var.log_group_names), "validate") ? 1 : 0
  name           = "${var.name}-invoices-checked"
  log_group_name = var.log_group_names["validate"]
  pattern        = "?\"-> checked\" ?\"-> confirmed\""

  metric_transformation {
    namespace     = local.namespace
    name          = "InvoicesChecked"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "invoices_needs_review" {
  count          = contains(keys(var.log_group_names), "validate") ? 1 : 0
  name           = "${var.name}-invoices-needs-review"
  log_group_name = var.log_group_names["validate"]
  pattern        = "\"-> needs_review\""

  metric_transformation {
    namespace     = local.namespace
    name          = "InvoicesNeedsReview"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# ---------------------------------------------------------------- alarms (10)

# 1-5: a function crashed (unhandled exception, timeout, out of memory).
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = toset(var.function_names)
  alarm_name          = "${each.value}-errors"
  alarm_description   = "Lambda ${each.value} reported errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]
}

# 6: a message used up all its retries (one alarm for both dead-letter queues).
resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${var.name}-dlq-not-empty"
  alarm_description   = "Messages in a dead-letter queue (${join(", ", var.dlq_names)}): processing failed after all retries"
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "Messages in dead-letter queues"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = { for i, q in var.dlq_names : "q${i}" => q }
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/SQS"
        metric_name = "ApproximateNumberOfMessagesVisible"
        dimensions  = { QueueName = metric_query.value }
        stat        = "Maximum"
        period      = 300
      }
    }
  }
}

# 7: the pipeline is stuck: the oldest waiting message is older than the limit.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name}-queue-backlog"
  alarm_description   = "Oldest message in a work queue (${join(", ", var.queue_names)}) has waited more than ${var.queue_age_threshold_seconds} s: invoices are not being processed"
  evaluation_periods  = 2
  threshold           = var.queue_age_threshold_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]

  metric_query {
    id          = "oldest"
    expression  = "MAX(METRICS())"
    label       = "Age of the oldest message (s)"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = { for i, q in var.queue_names : "q${i}" => q }
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/SQS"
        metric_name = "ApproximateAgeOfOldestMessage"
        dimensions  = { QueueName = metric_query.value }
        stat        = "Maximum"
        period      = 300
      }
    }
  }
}

# 8: the API itself is failing (not the caller's fault).
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "The API returned ${var.api_5xx_threshold} or more 5xx responses in 5 minutes"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = var.api_id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.api_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]
}

# 9: Lambda refused invocations (account concurrency limit reached).
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${var.name}-lambda-throttles"
  alarm_description   = "A function was throttled: the account concurrency limit was reached"
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "Throttled invocations"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = { for i, f in var.function_names : "f${i}" => f }
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/Lambda"
        metric_name = "Throttles"
        dimensions  = { FunctionName = metric_query.value }
        stat        = "Sum"
        period      = 300
      }
    }
  }
}

# 10: errors the functions caught and logged themselves (Gemini failures,
# bad messages) plus timeouts, from the log metric filters above.
resource "aws_cloudwatch_metric_alarm" "logged_errors" {
  alarm_name          = "${var.name}-logged-errors"
  alarm_description   = "Functions logged ${var.logged_errors_threshold} or more errors in 5 minutes (see the 'Recent errors' widget on the dashboard)"
  namespace           = local.namespace
  metric_name         = "LoggedErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.logged_errors_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  ok_actions          = [aws_sns_topic.ops.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.handled_errors]
}

locals {
  alarm_arns = concat(
    [for a in aws_cloudwatch_metric_alarm.lambda_errors : a.arn],
    [
      aws_cloudwatch_metric_alarm.dlq.arn,
      aws_cloudwatch_metric_alarm.queue_age.arn,
      aws_cloudwatch_metric_alarm.api_5xx.arn,
      aws_cloudwatch_metric_alarm.lambda_throttles.arn,
      aws_cloudwatch_metric_alarm.logged_errors.arn,
    ],
  )
}

# ---------------------------------------------------------------- saved log queries (free)

resource "aws_cloudwatch_query_definition" "errors" {
  name            = "${var.name}/Recent errors in all functions"
  log_group_names = values(var.log_group_names)
  query_string    = <<-EOT
    fields @timestamp, @log, @message
    | filter @message like /\[ERROR\]|Task timed out/
    | sort @timestamp desc
    | limit 50
  EOT
}

resource "aws_cloudwatch_query_definition" "slow_routes" {
  name            = "${var.name}/API latency and errors by route"
  log_group_names = [var.api_log_group_name]
  query_string    = <<-EOT
    fields route, status, latency
    | stats count(*) as requests, avg(latency) as avg_ms, pct(latency, 95) as p95_ms by route, status
    | sort p95_ms desc
  EOT
}

resource "aws_cloudwatch_query_definition" "cold_starts" {
  name            = "${var.name}/Cold starts and memory by function"
  log_group_names = values(var.log_group_names)
  query_string    = <<-EOT
    filter @type = "REPORT"
    | stats count(*) as invocations, count(@initDuration) as cold_starts,
            avg(@duration) as avg_ms, pct(@duration, 95) as p95_ms,
            max(@maxMemoryUsed) / 1000000 as max_memory_mb by @log
  EOT
}

# ---------------------------------------------------------------- dashboard

locals {
  w_alarms = {
    type = "alarm", x = 0, y = 0, width = 24, height = 3
    properties = {
      title  = "Alarms"
      alarms = local.alarm_arns
    }
  }

  w_api = [
    {
      type = "metric", x = 0, y = 3, width = 12, height = 6
      properties = {
        title  = "API: requests and errors"
        region = local.region
        stat   = "Sum"
        period = 300
        metrics = [
          ["AWS/ApiGateway", "Count", "ApiId", var.api_id, { label = "Requests" }],
          ["AWS/ApiGateway", "4xx", "ApiId", var.api_id, { label = "4xx (incl. 429 throttled)", color = "#ff7f0e" }],
          ["AWS/ApiGateway", "5xx", "ApiId", var.api_id, { label = "5xx", color = "#d62728" }],
        ]
      }
    },
    {
      type = "metric", x = 12, y = 3, width = 12, height = 6
      properties = {
        title  = "API: latency (ms)"
        region = local.region
        period = 300
        metrics = [
          ["AWS/ApiGateway", "Latency", "ApiId", var.api_id, { stat = "p50", label = "p50" }],
          ["AWS/ApiGateway", "Latency", "ApiId", var.api_id, { stat = "p95", label = "p95" }],
          ["AWS/ApiGateway", "IntegrationLatency", "ApiId", var.api_id, { stat = "p95", label = "p95 inside Lambda" }],
        ]
      }
    },
  ]

  w_lambda = [
    {
      type = "metric", x = 0, y = 9, width = 8, height = 6
      properties = {
        title   = "Lambda: invocations"
        region  = local.region
        stat    = "Sum"
        period  = 300
        metrics = [for f in var.function_names : ["AWS/Lambda", "Invocations", "FunctionName", f, { label = local.fn_short[f] }]]
      }
    },
    {
      type = "metric", x = 8, y = 9, width = 8, height = 6
      properties = {
        title  = "Lambda: errors, logged errors, throttles"
        region = local.region
        stat   = "Sum"
        period = 300
        metrics = concat(
          [for f in var.function_names : ["AWS/Lambda", "Errors", "FunctionName", f, { label = "${local.fn_short[f]} errors" }]],
          [[local.namespace, "LoggedErrors", { label = "logged errors (all)", color = "#d62728" }]],
          [for f in var.function_names : ["AWS/Lambda", "Throttles", "FunctionName", f, { label = "${local.fn_short[f]} throttles" }]],
        )
      }
    },
    {
      type = "metric", x = 16, y = 9, width = 8, height = 6
      properties = {
        title   = "Lambda: duration p95 (ms)"
        region  = local.region
        stat    = "p95"
        period  = 300
        metrics = [for f in var.function_names : ["AWS/Lambda", "Duration", "FunctionName", f, { label = local.fn_short[f] }]]
      }
    },
  ]

  w_pipeline = [
    {
      type = "metric", x = 0, y = 15, width = 8, height = 6
      properties = {
        title   = "Queues: waiting messages"
        region  = local.region
        stat    = "Maximum"
        period  = 300
        metrics = [for q in concat(var.queue_names, var.dlq_names) : ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", q]]
      }
    },
    {
      type = "metric", x = 8, y = 15, width = 8, height = 6
      properties = {
        title   = "Queues: age of the oldest message (s)"
        region  = local.region
        stat    = "Maximum"
        period  = 300
        metrics = [for q in var.queue_names : ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", q]]
        annotations = {
          horizontal = [{ label = "alarm", value = var.queue_age_threshold_seconds }]
        }
      }
    },
    {
      type = "metric", x = 16, y = 15, width = 8, height = 6
      properties = {
        title  = "AI quality: invoices checked vs needing review"
        region = local.region
        stat   = "Sum"
        period = 3600
        view   = "timeSeries"
        metrics = [
          [local.namespace, "InvoicesChecked", { label = "passed all checks", color = "#2ca02c" }],
          [local.namespace, "InvoicesNeedsReview", { label = "needs review", color = "#ff7f0e" }],
        ]
      }
    },
  ]

  w_data = [
    {
      type = "metric", x = 0, y = 21, width = 8, height = 6
      properties = {
        title  = "DynamoDB: consumed capacity and throttles"
        region = local.region
        stat   = "Sum"
        period = 300
        metrics = [
          ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", var.table_name, { label = "read units" }],
          ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", var.table_name, { label = "write units" }],
          ["AWS/DynamoDB", "ReadThrottleEvents", "TableName", var.table_name, { label = "read throttles", color = "#d62728" }],
          ["AWS/DynamoDB", "WriteThrottleEvents", "TableName", var.table_name, { label = "write throttles", color = "#9467bd" }],
        ]
      }
    },
    {
      type = "metric", x = 8, y = 21, width = 8, height = 6
      properties = {
        title  = "CloudFront: requests and error rate"
        region = "us-east-1" # CloudFront and its WAF report metrics in us-east-1
        period = 300
        metrics = [
          ["AWS/CloudFront", "Requests", "DistributionId", var.distribution_id, "Region", "Global", { stat = "Sum", label = "requests" }],
          ["AWS/CloudFront", "4xxErrorRate", "DistributionId", var.distribution_id, "Region", "Global", { stat = "Average", label = "4xx %", yAxis = "right" }],
          ["AWS/CloudFront", "5xxErrorRate", "DistributionId", var.distribution_id, "Region", "Global", { stat = "Average", label = "5xx %", yAxis = "right" }],
        ]
      }
    },
  ]

  w_waf_off = {
    type = "text", x = 16, y = 21, width = 8, height = 6
    properties = {
      markdown = "### Firewall (WAF)\nNot enabled in this environment.\n\nSet `enable_waf = true` to put AWS WAF in front of CloudFront (about $9/month). Until then the site is protected by CloudFront's built-in DDoS protection (AWS Shield Standard), HTTPS only, security headers and API throttling."
    }
  }

  w_waf_on = {
    type = "metric", x = 16, y = 21, width = 8, height = 6
    properties = {
      title  = "WAF: allowed and blocked requests"
      region = "us-east-1"
      stat   = "Sum"
      period = 300
      metrics = [
        ["AWS/WAFV2", "AllowedRequests", "WebACL", coalesce(var.web_acl_name, "none"), "Rule", "ALL", { label = "allowed", color = "#2ca02c" }],
        ["AWS/WAFV2", "BlockedRequests", "WebACL", coalesce(var.web_acl_name, "none"), "Rule", "ALL", { label = "blocked", color = "#d62728" }],
      ]
    }
  }

  # jsonencode first: the two widgets have different shapes, which a plain
  # conditional expression does not accept.
  w_waf = jsondecode(var.web_acl_name == null ? jsonencode(local.w_waf_off) : jsonencode(local.w_waf_on))

  w_logs = {
    type = "log", x = 0, y = 27, width = 24, height = 6
    properties = {
      title  = "Recent errors (all functions)"
      region = local.region
      view   = "table"
      query  = "${join(" | ", [for g in values(var.log_group_names) : "SOURCE '${g}'"])} | fields @timestamp, @log, @message | filter @message like /\\[ERROR\\]|Task timed out/ | sort @timestamp desc | limit 20"
    }
  }
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = concat([local.w_alarms], local.w_api, local.w_lambda, local.w_pipeline, local.w_data, [local.w_waf, local.w_logs])
  })
}

# ---------------------------------------------------------------- budget

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_limit_usd > 0 && var.alarm_email != "" ? 1 : 0
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alarm_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alarm_email]
  }
}
