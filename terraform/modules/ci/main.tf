# GitHub Actions -> AWS without stored keys: an OpenID Connect provider and
# two roles that only workflows from one repository can assume.
#
#   plan role    pull requests and main: reads the account for `terraform plan`.
#                It cannot change resources and cannot read the data itself
#                (invoice files, table items, secrets, user list).
#   deploy role  optional (create_deploy_role): `terraform apply` from the
#                GitHub Environment named after this environment, which is
#                where the required-reviewer approval is configured.
#
# Nothing here runs by itself: the workflows stay skipped until the role ARNs
# are saved as repository variables (see docs/cicd.md).

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  partition    = data.aws_partition.current.partition
  oidc_host    = "token.actions.githubusercontent.com"
  provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:${local.partition}:iam::${local.account_id}:oidc-provider/${local.oidc_host}"
  state_prefix = trimsuffix(var.state_key_prefix, "/")
}

# One provider per AWS account: the first environment creates it, the second
# one (create_oidc_provider = false) reuses it.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

# ---------------------------------------------------------------- plan role

data "aws_iam_policy_document" "assume_plan" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only pull requests and the main branch of this repository, not any branch or tag.
    condition {
      test     = "StringLike"
      variable = "${local.oidc_host}:sub"
      values = [
        "repo:${var.github_repository}:pull_request",
        "repo:${var.github_repository}:ref:refs/heads/main",
      ]
    }
  }
}

resource "aws_iam_role" "plan" {
  name                 = "${var.name}-github-plan"
  description          = "terraform plan from GitHub Actions (read-only)"
  assume_role_policy   = data.aws_iam_policy_document.assume_plan.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "read_only" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

# ReadOnlyAccess also allows reading the data inside the services. A plan
# only needs configuration, so the data reads are denied explicitly.
data "aws_iam_policy_document" "plan_deny_data" {
  statement {
    sid    = "NoBusinessData"
    effect = "Deny"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:GetRecords",
      "dynamodb:PartiQLSelect",
      "sqs:ReceiveMessage",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:StartQuery",
      "logs:GetQueryResults",
      "cognito-idp:ListUsers",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListDevices",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "NoSecrets"
    effect = "Deny"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:GetParameterHistory",
      "secretsmanager:GetSecretValue",
      "kms:Decrypt",
    ]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = var.uploads_bucket_arn == null ? [] : [var.uploads_bucket_arn]
    content {
      sid       = "NoInvoiceFiles"
      effect    = "Deny"
      actions   = ["s3:GetObject", "s3:GetObjectVersion"]
      resources = ["${statement.value}/*"]
    }
  }
}

resource "aws_iam_role_policy" "plan_deny_data" {
  name   = "deny-data-reads"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan_deny_data.json
}

resource "aws_iam_role_policy" "state" {
  name = "terraform-state"
  role = aws_iam_role.plan.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = "arn:${local.partition}:s3:::${var.state_bucket}"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "arn:${local.partition}:s3:::${var.state_bucket}/${local.state_prefix}/*"
      },
      {
        # plan only takes the lock; it never writes state
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "arn:${local.partition}:s3:::${var.state_bucket}/${local.state_prefix}/*.tflock"
      },
    ]
  })
}

# ---------------------------------------------------------------- deploy role (optional)

data "aws_iam_policy_document" "assume_deploy" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only jobs that run in the GitHub Environment with this name. Protection
    # rules of that Environment (required reviewers, main branch only) apply
    # before GitHub issues the token.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  count                = var.create_deploy_role ? 1 : 0
  name                 = "${var.name}-github-deploy"
  description          = "terraform apply from the GitHub Environment '${var.github_environment}'"
  assume_role_policy   = data.aws_iam_policy_document.assume_deploy.json
  max_session_duration = 3600
}

# Every service except IAM, Organizations and account settings.
resource "aws_iam_role_policy_attachment" "deploy_power_user" {
  count      = var.create_deploy_role ? 1 : 0
  role       = aws_iam_role.deploy[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "deploy" {
  # IAM only for this environment's own roles (Lambda and scheduler roles).
  statement {
    sid = "ManageProjectRoles"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:GetRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${var.name}-*"]
  }

  # Roles may be handed only to the two services that run them.
  statement {
    sid       = "PassProjectRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${var.name}-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com", "scheduler.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadOidcProvider"
    actions   = ["iam:GetOpenIDConnectProvider", "iam:ListOpenIDConnectProviders"]
    resources = ["*"]
  }

  # Service-linked roles some services create on first use.
  statement {
    sid       = "ServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/aws-service-role/*"]
  }

  # The pipeline cannot widen its own access: the GitHub roles and the OIDC
  # provider are changed only by the owner, from their own machine.
  statement {
    sid    = "NoSelfEscalation"
    effect = "Deny"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
    ]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/*-github-*"]
  }

  statement {
    sid       = "NoOidcProviderChanges"
    effect    = "Deny"
    actions   = ["iam:CreateOpenIDConnectProvider", "iam:DeleteOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint", "iam:AddClientIDToOpenIDConnectProvider", "iam:RemoveClientIDFromOpenIDConnectProvider"]
    resources = ["*"]
  }

  # State: only this environment's key, never the other environment's.
  statement {
    sid       = "StateBucketList"
    actions   = ["s3:ListBucket"]
    resources = ["arn:${local.partition}:s3:::${var.state_bucket}"]
  }

  dynamic "statement" {
    for_each = length(var.protected_state_prefixes) == 0 ? [] : [1]
    content {
      sid       = "NoOtherEnvironmentState"
      effect    = "Deny"
      actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      resources = [for p in var.protected_state_prefixes : "arn:${local.partition}:s3:::${var.state_bucket}/${trimsuffix(p, "/")}/*"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  count  = var.create_deploy_role ? 1 : 0
  name   = "deploy"
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.deploy.json
}
