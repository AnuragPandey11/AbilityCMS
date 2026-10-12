terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {
    bucket       = "solarcms-terraform-state-556935884877"
    key          = "production/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

# Every resource is tagged, so the console shows which ones Terraform owns.
provider "aws" {
  region = "ap-south-1"
  default_tags {
    tags = { Project = "solarcms", ManagedBy = "terraform" }
  }
}

# Route 53 reports health checks in US East (N. Virginia), so their alarms live there.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { Project = "solarcms", ManagedBy = "terraform" }
  }
}
