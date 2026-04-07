output "lb_ip" {
  description = "Load balancer public IP"
  value       = hcloud_load_balancer.main.ipv4
}

output "nat_ip" {
  description = "NAT gateway / SSH bastion public IP"
  value       = hcloud_server.nat.ipv4_address
}

output "redis_private_ip" {
  description = "Redis private IP"
  value       = "10.0.1.10"
}

output "app_private_ips" {
  description = "App server private IPs"
  value       = ["10.0.1.11", "10.0.1.12"]
}
