# One customer-managed KMS key for the project's data at rest: the DynamoDB
# table, the uploads bucket and the SQS queues. Rotated every year.
#
# Without this module the same data is still encrypted, with keys AWS owns
# (free). A customer-managed key adds what an audit asks for: the key policy
# says who may decrypt, every use is in CloudTrail, and disabling the key
# makes the data unreadable at once.
#
# Cost (not in the free tier): $1/month per key + $0.03 per 10 000 requests
# (20 000 requests/month free). Created only when enable_kms = true.

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "key" {
  # The account decides through IAM who may use the key (Lambda roles get
  # exact permissions in terraform/iam.tf).
  statement {
    sid       = "AccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # S3 puts ObjectCreated events on the encrypted extract queue.
  statement {
    sid       = "S3EventsToEncryptedQueue"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_kms_key" "this" {
  description             = "${var.name}: table, uploads bucket and queues"
  enable_key_rotation     = true
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}
