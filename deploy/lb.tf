resource "hcloud_load_balancer" "main" {
  name               = "chop-ax-lb"
  load_balancer_type = "lb11"
  location           = "hel1"
}

resource "hcloud_load_balancer_network" "main" {
  load_balancer_id = hcloud_load_balancer.main.id
  network_id       = hcloud_network.main.id
  ip               = "10.0.1.100"

  depends_on = [hcloud_network_subnet.main]
}

# Self-signed TLS certificate for the LB's public IP
resource "tls_private_key" "lb" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_self_signed_cert" "lb" {
  private_key_pem = tls_private_key.lb.private_key_pem

  subject {
    common_name = hcloud_load_balancer.main.ipv4
  }

  ip_addresses          = [hcloud_load_balancer.main.ipv4]
  validity_period_hours = 8760 # 1 year

  allowed_uses = [
    "key_encipherment",
    "digital_signature",
    "server_auth",
  ]
}

resource "hcloud_uploaded_certificate" "lb" {
  name        = "chop-ax-lb"
  certificate = tls_self_signed_cert.lb.cert_pem
  private_key = tls_private_key.lb.private_key_pem
}

resource "hcloud_load_balancer_service" "https" {
  load_balancer_id = hcloud_load_balancer.main.id
  protocol         = "https"
  listen_port      = 443
  destination_port = 3000

  http {
    certificates = [hcloud_uploaded_certificate.lb.id]
  }

  health_check {
    protocol = "http"
    port     = 3000
    interval = 10
    timeout  = 5
    retries  = 3

    http {
      path         = "/"
      status_codes = ["200"]
    }
  }
}

resource "hcloud_load_balancer_target" "app" {
  count            = length(hcloud_server.app)
  type             = "server"
  load_balancer_id = hcloud_load_balancer.main.id
  server_id        = hcloud_server.app[count.index].id
  use_private_ip   = true

  depends_on = [hcloud_load_balancer_network.main]
}
