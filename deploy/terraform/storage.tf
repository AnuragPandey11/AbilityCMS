# Database backups (pgBackRest) and report files. Versioning stays off, and the
# backups bucket never gets a lifecycle rule: pgBackRest deletes old backups
# itself, in the right order. S3 encrypts both by default.
resource "aws_s3_bucket" "backups" {
  bucket = local.backups_bucket
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "reports" {
  bucket = local.reports_bucket
  lifecycle {
    prevent_destroy = true
  }
}

locals {
  buckets = {
    backups = aws_s3_bucket.backups.id
    reports = aws_s3_bucket.reports.id
  }
}

resource "aws_s3_bucket_public_access_block" "all" {
  for_each                = local.buckets
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "all" {
  for_each = local.buckets
  bucket   = each.value
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}
