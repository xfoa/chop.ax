terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "hcloud" {
  token = trimspace(file("~/.hcloud/api-key"))
}

# --- SSH Key ---

resource "hcloud_ssh_key" "default" {
  name       = "chop-ax"
  public_key = trimspace(file("~/.ssh/id_ed25519.pub"))
}

# --- Private Network ---

resource "hcloud_network" "main" {
  name     = "chop-ax"
  ip_range = "10.0.1.0/24"
}

resource "hcloud_network_subnet" "main" {
  network_id   = hcloud_network.main.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.0.1.0/24"
}

# --- Firewalls ---

resource "hcloud_firewall" "app" {
  name = "chop-ax-app"

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "App port (LB health checks)"
    direction   = "in"
    protocol    = "tcp"
    port        = "3000"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_firewall" "redis" {
  name = "chop-ax-redis"

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}
