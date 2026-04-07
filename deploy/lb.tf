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

resource "hcloud_load_balancer_service" "http" {
  load_balancer_id = hcloud_load_balancer.main.id
  protocol         = "http"
  listen_port      = 80
  destination_port = 3000

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
  count            = 2
  type             = "server"
  load_balancer_id = hcloud_load_balancer.main.id
  server_id        = hcloud_server.app[count.index].id
  use_private_ip   = true

  depends_on = [hcloud_load_balancer_network.main]
}
