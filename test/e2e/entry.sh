#!/bin/sh
set -e
install -d -m 700 /root/.ssh
if [ -n "$AUTHORIZED_KEY" ]; then
  printf '%s\n' "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi
if [ -n "$ROOT_PASSWORD" ]; then
  # Simulate a fresh VPS: root password login only.
  echo "root:$ROOT_PASSWORD" | chpasswd
  sed -i -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' -e 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
fi
# OpenRC without being PID 1, so lf harden can start fail2ban as on a real Alpine server.
mkdir -p /run/openrc && touch /run/openrc/softlevel
/usr/sbin/sshd
exec dockerd-entrypoint.sh dockerd --group docker
