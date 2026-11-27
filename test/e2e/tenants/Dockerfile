# An Ubuntu "server" with systemd and Docker from download.docker.com: what tenants (rootless Docker per user) need.
FROM ubuntu:24.04
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus dbus-user-session \
      openssh-server sudo ufw iptables iproute2 curl ca-certificates gnupg openssl apparmor rsync >/dev/null \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl enable ssh docker
RUN mkdir /e2e && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj /CN=e2e \
      -addext "subjectAltName=DNS:*.test,DNS:*.anna.test,DNS:*.ben.test" -keyout /e2e/key.pem -out /e2e/cert.pem 2>/dev/null
# securityfs: apparmor_parser loads the rootlesskit profile when the host kernel restricts user namespaces.
CMD ["sh", "-c", "mount -t securityfs securityfs /sys/kernel/security 2>/dev/null; install -d -m 700 /root/.ssh && printf '%s\\n' \"$AUTHORIZED_KEY\" > /root/.ssh/authorized_keys && exec /sbin/init"]
