output "data_ip" {
  description = "The data server's fixed public address: DATA_IP."
  value       = aws_eip.data.public_ip
}

output "app_ip" {
  description = "The app server's fixed public address: APP_IP."
  value       = aws_eip.app.public_ip
}

output "data_instance_id" {
  description = "DATA_ID."
  value       = aws_instance.data.id
}

output "data_private_ip" {
  description = "DATA_PRIVATE_IP: how the app reaches the database and the broker."
  value       = aws_instance.data.private_ip
}

output "app_instance_id" {
  description = "APP_ID."
  value       = aws_instance.app.id
}

output "server_dns_records" {
  description = "Add at the DNS provider (step 3.3), unless manage_dns is true."
  value = [
    { name = "api.${var.domain}", type = "A", value = aws_eip.app.public_ip },
    { name = "mqtt.${var.domain}", type = "A", value = aws_eip.data.public_ip },
  ]
}

output "email_dns_records" {
  description = "Add at the DNS provider (step 7.1), unless manage_dns is true."
  value       = local.email_dns_records
}
