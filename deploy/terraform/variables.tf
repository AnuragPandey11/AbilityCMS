variable "domain" {
  description = "The domain the app., api. and mqtt. names live under, without www."
  type        = string
}

variable "alert_emails" {
  description = "Who receives every server alarm. The first also receives DMARC reports."
  type        = list(string)
  validation {
    condition     = length(var.alert_emails) >= 1
    error_message = "List at least one alert email."
  }
}

variable "data_type" {
  description = "Data server size, from the hosting plan."
  type        = string
}

variable "app_type" {
  description = "App server size, from the hosting plan."
  type        = string
}

variable "data_disk_gb" {
  description = "Database disk size in GB. It can grow later; it can never shrink."
  type        = number
  validation {
    condition     = var.data_disk_gb >= 50
    error_message = "The database disk needs at least 50 GB."
  }
}

variable "github_repo" {
  description = "owner/name of the GitHub repository whose workflows may log in to AWS."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "Write it as owner/name, for example AnuragPandey11/AbilityCMS."
  }
}

variable "data_zone" {
  description = "Data centre of the data server and its database disk."
  type        = string
  default     = "ap-south-1a"
}

variable "app_zone" {
  description = "Data centre of the app server."
  type        = string
  default     = "ap-south-1a"
}

variable "manage_dns" {
  description = "True only if the domain's DNS is in Route 53: Terraform then adds the DNS records too."
  type        = bool
  default     = false
}

variable "outside_checks" {
  description = "Whether Route 53 calls the API and the broker from outside. Off until both answer (step 11.4)."
  type        = bool
  default     = false
}

data "aws_caller_identity" "current" {}

locals {
  account_id     = data.aws_caller_identity.current.account_id
  backups_bucket = "solarcms-backups-${local.account_id}"
  reports_bucket = "solarcms-reports-${local.account_id}"
}
