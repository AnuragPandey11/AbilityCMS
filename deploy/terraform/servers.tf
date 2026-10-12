data "aws_ami" "ubuntu_arm" {
  owners      = ["099720109477"]
  most_recent = true
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
}

data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id"
}

# The data server: database and broker. Stages 5 and 6 set up everything inside it.
resource "aws_instance" "data" {
  ami                     = data.aws_ami.ubuntu_arm.id
  instance_type           = var.data_type
  subnet_id               = data.aws_subnet.data.id
  vpc_security_group_ids  = [aws_security_group.data.id]
  iam_instance_profile    = aws_iam_instance_profile.data.name
  disable_api_termination = true
  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }
  tags = { Name = "solarcms-data", Role = "data" }

  # A newer Ubuntu image or an edited start-up script must never replace this server.
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [ami, user_data]
  }
}

# The database disk is its own resource, so no change to the server can delete it.
resource "aws_ebs_volume" "pgdata" {
  availability_zone = var.data_zone
  size              = var.data_disk_gb
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "solarcms-pgdata" }
  lifecycle {
    prevent_destroy = true
  }
}

# /dev/sdf, not /dev/sdb: Ubuntu's image reserves /dev/sdb and /dev/sdc for
# instance-store disks, so AWS refuses to attach an EBS disk there even on a
# server that has none. Inside the server it is still /dev/nvme1n1 (step 5.3).
resource "aws_volume_attachment" "pgdata" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.pgdata.id
  instance_id = aws_instance.data.id
  lifecycle {
    prevent_destroy = true
  }
}

# The app server: ECS runs the app, Redis and the front door on it. It holds
# nothing that cannot be rebuilt, so it may be replaced (Everyday operations).
resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.ecs_ami.insecure_value
  instance_type          = var.app_type
  subnet_id              = data.aws_subnet.app.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name
  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }
  user_data = <<-EOT
    #!/bin/bash
    cat >> /etc/ecs/ecs.config <<'CFG'
    ECS_CLUSTER=${aws_ecs_cluster.main.name}
    ECS_ENABLE_TASK_IAM_ROLE=true
    ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true
    CFG
  EOT
  tags      = { Name = "solarcms-app", Role = "app" }

  # Moving to a newer ECS image is a deliberate replacement, never a side effect of apply.
  lifecycle {
    ignore_changes = [ami]
  }
}
