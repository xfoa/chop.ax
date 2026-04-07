locals {
  _env_lines = [
    for l in split("\n", file("${path.module}/.env")) :
    trimspace(l)
    if trimspace(l) != "" && !startswith(trimspace(l), "#")
  ]
  _env = {
    for l in local._env_lines :
    trimspace(split("=", l)[0]) =>
    trimspace(join("=", slice(split("=", l), 1, length(split("=", l)))))
  }

  grafana_prometheus_url  = local._env["GRAFANA_PROMETHEUS_URL"]
  grafana_prometheus_user = local._env["GRAFANA_PROMETHEUS_USER"]
  grafana_loki_url        = local._env["GRAFANA_LOKI_URL"]
  grafana_loki_user       = local._env["GRAFANA_LOKI_USER"]
  grafana_api_key         = local._env["GRAFANA_API_KEY"]

  app_redis_url      = local._env["REDIS_URL"]
  app_browser_pool   = local._env["BROWSER_POOL"]
  app_reader_workers = local._env["READER_WORKERS"]
  app_max_concurrent = local._env["MAX_CONCURRENT"]
  app_render_timeout = local._env["RENDER_TIMEOUT"]
  app_rate_window    = local._env["RATE_WINDOW"]
  app_rate_per_user  = local._env["RATE_PER_USER"]
  app_rate_per_ip    = local._env["RATE_PER_IP"]

  # Alloy APT repo setup + install (shared by all servers)
  alloy_install = join("\n", [
    "apt-get install -y gpg",
    "mkdir -p /etc/apt/keyrings",
    "wget -q -O - https://apt.grafana.com/gpg.key | gpg --dearmor -o /etc/apt/keyrings/grafana.gpg",
    "echo 'deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main' > /etc/apt/sources.list.d/grafana.list",
    "apt-get update",
    "apt-get install -y alloy",
  ])

  # Alloy config for app servers. __INSTANCE__ is replaced per server.
  alloy_app_config = <<-ALLOY
prometheus.exporter.unix "default" { }

prometheus.scrape "node" {
  targets         = prometheus.exporter.unix.default.targets
  forward_to      = [prometheus.remote_write.grafana.receiver]
  scrape_interval = "60s"
}

discovery.docker "containers" {
  host = "unix:///var/run/docker.sock"
}

loki.source.docker "default" {
  host       = "unix:///var/run/docker.sock"
  targets    = discovery.docker.containers.targets
  forward_to = [loki.write.grafana.receiver]
}

prometheus.remote_write "grafana" {
  endpoint {
    url = "${local.grafana_prometheus_url}"
    basic_auth {
      username = "${local.grafana_prometheus_user}"
      password = "${local.grafana_api_key}"
    }
  }
  external_labels = {
    instance = "__INSTANCE__",
    job      = "chop-ax",
  }
}

loki.write "grafana" {
  endpoint {
    url = "${local.grafana_loki_url}"
    basic_auth {
      username = "${local.grafana_loki_user}"
      password = "${local.grafana_api_key}"
    }
  }
  external_labels = {
    instance = "__INSTANCE__",
    job      = "chop-ax",
  }
}
ALLOY

  # Alloy config for the Redis server
  alloy_redis_config = <<-ALLOY
prometheus.exporter.unix "default" { }

prometheus.scrape "node" {
  targets         = prometheus.exporter.unix.default.targets
  forward_to      = [prometheus.remote_write.grafana.receiver]
  scrape_interval = "60s"
}

prometheus.exporter.redis "default" {
  redis_addr = "localhost:6379"
}

prometheus.scrape "redis" {
  targets         = prometheus.exporter.redis.default.targets
  forward_to      = [prometheus.remote_write.grafana.receiver]
  scrape_interval = "60s"
}

prometheus.remote_write "grafana" {
  endpoint {
    url = "${local.grafana_prometheus_url}"
    basic_auth {
      username = "${local.grafana_prometheus_user}"
      password = "${local.grafana_api_key}"
    }
  }
  external_labels = {
    instance = "chop-ax-redis",
    job      = "chop-ax",
  }
}
ALLOY
}
