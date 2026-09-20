# Grafana with the SQLite datasource built in.
#
# Built rather than pulled because the plugin cannot be installed at run time:
# GF_INSTALL_PLUGINS downloads on container start, and these containers are
# denied egress at the host firewall, which is a rule worth keeping. The build
# has a network; the running container does not.

ARG GRAFANA_VERSION=13.0.2

FROM grafana/grafana-oss:${GRAFANA_VERSION}

# Pinned like everything else here: a plugin that changes under us is a
# dashboard that stops rendering for a reason nobody can see in this repository.
ARG SQLITE_DATASOURCE_VERSION=4.0.6

USER root

RUN grafana cli --pluginsDir /var/lib/grafana/plugins \
        --pluginUrl https://github.com/fr-ser/grafana-sqlite-datasource/releases/download/v${SQLITE_DATASOURCE_VERSION}/frser-sqlite-datasource-${SQLITE_DATASOURCE_VERSION}.zip \
        plugins install frser-sqlite-datasource \
    && chown -R grafana:root /var/lib/grafana/plugins

USER grafana
