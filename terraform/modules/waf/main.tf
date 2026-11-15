# Web application firewall in front of CloudFront. The provider passed to this
# module must be in us-east-1: that is where CloudFront-scoped web ACLs live.
#
# Cost (not in the free tier): $5/month for the web ACL + $1/month per rule
# (4 rules = $4) + $0.60 per million requests. Created only when enable_waf = true.

locals {
  managed_rules = {
    # priority => AWS managed rule group (all three are free of extra fees)
    10 = "AWSManagedRulesAmazonIpReputationList" # known bots and attack sources
    20 = "AWSManagedRulesCommonRuleSet"          # OWASP top-10 style patterns
    30 = "AWSManagedRulesKnownBadInputsRuleSet"  # Log4Shell and similar probes
  }
}

resource "aws_wafv2_web_acl" "this" {
  name        = var.name
  description = "Rate limit per IP and AWS managed rules for ${var.name}"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # One address may not flood the site: over the limit in 5 minutes -> blocked.
  rule {
    name     = "rate-limit-per-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.rate_limit
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = local.managed_rules
    content {
      name     = rule.value
      priority = rule.key

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.value
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-${rule.value}"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}
