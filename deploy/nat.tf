resource "hcloud_firewall" "nat" {
  name = "chop-ax-nat"

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "nat" {
  name        = "chop-ax-nat"
  server_type = "cax11"
  location    = "hel1"
  image       = "debian-12"
  ssh_keys    = [hcloud_ssh_key.default.id]
  firewall_ids = [hcloud_firewall.nat.id]

  user_data = <<-CLOUDINIT
    #cloud-config
    package_update: true

    runcmd:
      - echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
      - sysctl -p
      - iptables -t nat -A POSTROUTING -s 10.0.1.0/24 -o eth0 -j MASQUERADE
      - apt-get install -y iptables-persistent
      - iptables-save > /etc/iptables/rules.v4
  CLOUDINIT

  depends_on = [hcloud_network_subnet.main]
}

resource "hcloud_server_network" "nat" {
  server_id  = hcloud_server.nat.id
  network_id = hcloud_network.main.id
  ip         = "10.0.1.2"
}

resource "hcloud_network_route" "default" {
  network_id  = hcloud_network.main.id
  destination = "0.0.0.0/0"
  gateway     = "10.0.1.2"

  depends_on = [hcloud_server_network.nat]
}
