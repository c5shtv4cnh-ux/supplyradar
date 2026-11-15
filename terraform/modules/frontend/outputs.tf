output "url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "bucket_id" {
  value = aws_s3_bucket.site.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.site.arn
}

output "web_acl_arn" {
  value = aws_cloudfront_distribution.site.web_acl_id
}
