#!/usr/bin/env bash
# Fix malformed Docker APT entry
set -euo pipefail

# Backup existing file if present
if [ -f /etc/apt/sources.list.d/docker.list ]; then
  cp /etc/apt/sources.list.d/docker.list \
     /etc/apt/sources.list.d/docker.list.bak.$(date -u +%Y%m%d%H%M%S)
  echo "Backed up original /etc/apt/sources.list.d/docker.list to docker.list.bak.*"
fi

# Remove any malformed entries
rm -f /etc/apt/sources.list.d/docker.list

# Ensure the directory exists
mkdir -p /etc/apt/keyrings

# Re‑add a correct Docker repo line
cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
$(lsb_release -cs) stable
EOF
echo "Re‑added correct Docker APT entry."

# If GPG key was missing, add it
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
   gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "Downloaded and installed Docker GPG key."
fi

# Update package lists
apt-get update
echo "Docker APT repository is ready."