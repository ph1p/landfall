# A Debian "server" for what the Alpine box cannot show: apt's automatic security updates.
FROM debian:12-slim
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server unattended-upgrades >/dev/null \
 && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/20auto-upgrades && mkdir -p /run/sshd
CMD ["sh", "-c", "install -d -m 700 /root/.ssh && printf '%s\\n' \"$AUTHORIZED_KEY\" > /root/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]
