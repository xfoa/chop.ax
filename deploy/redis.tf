resource "hcloud_server" "redis" {
  name        = "chop-ax-redis"
  server_type = "cax21"
  location    = "hel1"
  image       = "debian-12"
  ssh_keys    = [hcloud_ssh_key.default.id]
  firewall_ids = [hcloud_firewall.redis.id]

  public_net {
    ipv4_enabled = false
    ipv6_enabled = false
  }

  user_data = <<-CLOUDINIT
    #cloud-config
    write_files:
      - path: /etc/redis/redis.conf.d/chop.conf
        content: |
          bind 10.0.1.10 127.0.0.1
          protected-mode no
          appendonly yes
          maxmemory 6gb
          maxmemory-policy allkeys-lru

    runcmd:
      # Set default route through NAT gateway
      - |
        for i in $(seq 1 30); do
          if ip route | grep -q '10.0.1.0/24'; then
            ip route replace default via 10.0.1.1
            break
          fi
          sleep 2
        done
      # Set DNS
      - printf 'nameserver 185.12.64.1\nnameserver 185.12.64.2\n' > /etc/resolv.conf
      # Wait for internet access through NAT
      - |
        for i in $(seq 1 60); do
          if ping -c1 -W5 185.12.64.1 > /dev/null 2>&1; then
            break
          fi
          sleep 5
        done
      # Install packages
      - apt-get update
      - apt-get install -y redis-server resolvconf
      # Persist DNS via resolvconf
      - mkdir -p /etc/resolvconf/resolv.conf.d
      - printf 'nameserver 185.12.64.1\nnameserver 185.12.64.2\n' > /etc/resolvconf/resolv.conf.d/head
      - resolvconf -u
      - mkdir -p /etc/redis/redis.conf.d
      - |
        if ! grep -q 'include /etc/redis/redis.conf.d' /etc/redis/redis.conf; then
          echo 'include /etc/redis/redis.conf.d/*.conf' >> /etc/redis/redis.conf
        fi
      - systemctl restart redis-server
      - systemctl enable redis-server
      # Persist default route across reboots
      - echo 'ip route replace default via 10.0.1.1' >> /etc/rc.local
      - chmod +x /etc/rc.local
  CLOUDINIT

  network {
    network_id = hcloud_network.main.id
    ip         = "10.0.1.10"
  }

  depends_on = [hcloud_network_subnet.main, hcloud_network_route.default]
}
