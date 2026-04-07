resource "hcloud_server" "app" {
  count       = 2
  name        = "chop-ax-app-${count.index + 1}"
  server_type = "cax31"
  location    = "hel1"
  image       = "debian-12"
  ssh_keys    = [hcloud_ssh_key.default.id]
  firewall_ids = [hcloud_firewall.app.id]

  public_net {
    ipv4_enabled = false
    ipv6_enabled = false
  }

  user_data = <<-CLOUDINIT
    #cloud-config
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
      # Install base packages
      - apt-get update
      - apt-get install -y ca-certificates curl git resolvconf
      # Persist DNS via resolvconf
      - mkdir -p /etc/resolvconf/resolv.conf.d
      - printf 'nameserver 185.12.64.1\nnameserver 185.12.64.2\n' > /etc/resolvconf/resolv.conf.d/head
      - resolvconf -u

      # Install Docker
      - install -m 0755 -d /etc/apt/keyrings
      - curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
      - chmod a+r /etc/apt/keyrings/docker.asc
      - |
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
      - apt-get update
      - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

      # Install Grafana Alloy
      - |
        ${indent(8, local.alloy_install)}
      - usermod -aG docker alloy
      - echo '${base64encode(replace(local.alloy_app_config, "__INSTANCE__", "chop-ax-app-${count.index + 1}"))}' | base64 -d > /etc/alloy/config.alloy
      - systemctl restart alloy
      - systemctl enable alloy

      # Clone and build
      - git clone https://github.com/xfoa/chop.ax /opt/chop.ax
      - docker build -t chop-ax /opt/chop.ax

      # Run the app container
      - |
        docker run -d --name chop-ax \
          --restart unless-stopped \
          --security-opt seccomp=unconfined \
          --shm-size 1g \
          -p 3000:3000 \
          -e REDIS_URL=${local.app_redis_url} \
          -e BROWSER_POOL=${local.app_browser_pool} \
          -e READER_WORKERS=${local.app_reader_workers} \
          -e MAX_CONCURRENT=${local.app_max_concurrent} \
          -e RENDER_TIMEOUT=${local.app_render_timeout} \
          -e RATE_WINDOW=${local.app_rate_window} \
          -e RATE_PER_USER=${local.app_rate_per_user} \
          -e RATE_PER_IP=${local.app_rate_per_ip} \
          chop-ax

      # Persist default route across reboots
      - echo 'ip route replace default via 10.0.1.1' >> /etc/rc.local
      - chmod +x /etc/rc.local
  CLOUDINIT

  network {
    network_id = hcloud_network.main.id
    ip         = "10.0.1.${count.index + 11}"
  }

  depends_on = [hcloud_network_subnet.main, hcloud_network_route.default]
}
