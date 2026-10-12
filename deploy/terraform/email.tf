# Amazon SES sends only from a domain proved by DKIM: three DNS records that
# also sign every email. A DMARC record tells mail servers what to do with
# mail that fails them.
resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

locals {
  email_dns_records = concat(
    [for token in aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens : {
      name  = "${token}._domainkey.${var.domain}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }],
    [{ name = "_dmarc.${var.domain}", type = "TXT", value = "v=DMARC1; p=none; rua=mailto:${var.alert_emails[0]}" }],
  )
}

# Only when the domain's DNS is in Route 53. SES always issues three DKIM records.
resource "aws_route53_record" "email" {
  count   = var.manage_dns ? 4 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = local.email_dns_records[count.index].name
  type    = local.email_dns_records[count.index].type
  ttl     = 1800
  records = [local.email_dns_records[count.index].value]
}
