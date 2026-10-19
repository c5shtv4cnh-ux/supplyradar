# One least-privilege policy per function: exact table, bucket prefix, queue,
# topic and parameter ARNs, only the actions that function's code calls.

locals {
  uploads_objects = "${module.storage.bucket_arn}/uploads/*"
  sqs_consume     = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
    resources = [module.database.table_arn]
  }
  statement {
    sid       = "PresignUploadsAndDownloads"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = [local.uploads_objects]
  }
  statement {
    sid       = "SendConfirmedInvoices"
    actions   = ["sqs:SendMessage"]
    resources = [module.validate_queue.queue_arn]
  }
  statement {
    sid       = "ManageEmailSubscriptions"
    actions   = ["sns:Subscribe", "sns:Unsubscribe", "sns:GetSubscriptionAttributes"]
    resources = [module.notifications.alerts_topic_arn, "${module.notifications.alerts_topic_arn}:*"]
  }
}

data "aws_iam_policy_document" "extract" {
  statement {
    sid       = "ReadUploads"
    actions   = ["s3:GetObject"]
    resources = [local.uploads_objects]
  }
  statement {
    sid       = "GeminiKey"
    actions   = ["ssm:GetParameter"]
    resources = [local.gemini_key_arn]
  }
  statement {
    sid       = "ConsumeExtractQueue"
    actions   = concat(local.sqs_consume, ["sqs:ChangeMessageVisibility"])
    resources = [module.extract_queue.queue_arn]
  }
  statement {
    sid       = "SendToValidate"
    actions   = ["sqs:SendMessage"]
    resources = [module.validate_queue.queue_arn]
  }
  statement {
    sid       = "InvoiceStatus"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [module.database.table_arn]
  }
}

data "aws_iam_policy_document" "validate" {
  statement {
    sid       = "ConsumeValidateQueue"
    actions   = local.sqs_consume
    resources = [module.validate_queue.queue_arn]
  }
  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
    resources = [module.database.table_arn]
  }
}

data "aws_iam_policy_document" "notify" {
  statement {
    sid       = "ReadStream"
    actions   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"]
    resources = [module.database.stream_arn]
  }
  statement {
    sid       = "ListStreams"
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }
  statement {
    sid       = "PublishAlerts"
    actions   = ["sns:Publish"]
    resources = [module.notifications.alerts_topic_arn]
  }
}

data "aws_iam_policy_document" "digest" {
  statement {
    sid       = "Table"
    actions   = ["dynamodb:Scan", "dynamodb:Query"]
    resources = [module.database.table_arn]
  }
  statement {
    sid       = "GeminiKey"
    actions   = ["ssm:GetParameter"]
    resources = [local.gemini_key_arn]
  }
  statement {
    sid       = "PublishDigest"
    actions   = ["sns:Publish"]
    resources = [module.notifications.alerts_topic_arn]
  }
}
