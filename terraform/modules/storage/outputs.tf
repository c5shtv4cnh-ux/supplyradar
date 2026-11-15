output "bucket_id" {
  value = aws_s3_bucket.uploads.id
}

output "bucket_arn" {
  value = aws_s3_bucket.uploads.arn
}

output "versioning_status" {
  value = aws_s3_bucket_versioning.uploads.versioning_configuration[0].status
}
