#!/usr/bin/env bash
# The box image v2 (docs/CLOUD.md section 3, "OpenCode, a second cloud engine"), on top of anyapp-box-v1: run on a box made
# from v1 as its login user, then save the box as `anyapp-box-v2`
# (`node cloud/scripts/box.mjs snapshot <id> anyapp-box-v2`) and set BOX_IMAGE_SNAPSHOT=anyapp-box-v2
# on the Convex deployment. It adds opencode (the cloud's second engine, `opencode acp`) where the
# agent's PATH finds it (/opt/kiwi/agent.sh: /opt/npm/bin), and the folder the runner writes each
# opencode session's config into (read by the agent through the kiwi group).
# Claude keeps working on v2 exactly as on v1.
set -euo pipefail
OPENCODE_VERSION=2.4.1

sudo mkdir -p /opt/npm
# The agent-browser template ships an old opencode (opencode-ai 1.19.5) at /opt/npm/bin/opencode: it goes first.
sudo npm uninstall --global --prefix /opt/npm --loglevel=error opencode-ai || true
sudo npm install --global --prefix /opt/npm --no-audit --no-fund --loglevel=error "@opencode/cli@${OPENCODE_VERSION}"
got=$(sudo -n -u agent -H /opt/kiwi/agent.sh opencode --version | tr -d '\r' | tail -n 1)
case "$got" in *"$OPENCODE_VERSION"*) echo "opencode $got for the agent" ;; *) echo "the agent sees opencode '$got', not $OPENCODE_VERSION" >&2; exit 1 ;; esac

# Each session's opencode.json: written by the runner, read by the agent, nobody else.
sudo mkdir -p /data/apps/.opencode
sudo chown "$(id -un):kiwi" /data/apps/.opencode && sudo chmod 2750 /data/apps/.opencode

# opencode keeps its sessions and its database in the agent's home (resume after a pause).
sudo mkdir -p /home/agent/.local/share/opencode /home/agent/.config/opencode
sudo chown -R agent:kiwi /home/agent/.local /home/agent/.config
echo "provisioned v2 as $(id -un)"
