FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      openjdk-21-jre-headless \
      unzip \
      zip \
    && rm -rf /var/lib/apt/lists/*
