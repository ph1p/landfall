# An rpm "server" with systemd for dnf's automatic updates: fedora (dnf5) or rockylinux:9 (dnf 4).
ARG BASE=fedora:42
FROM $BASE
# UsePAM no: Rocky 9's openssh 9.9 refuses root in PAM's account check inside a container.
RUN dnf install -y -q systemd openssh-server >/dev/null && dnf clean all && systemctl enable sshd \
  && echo "UsePAM no" > /etc/ssh/sshd_config.d/01-e2e.conf
CMD ["sh", "-c", "install -d -m 700 /root/.ssh && printf '%s\\n' \"$AUTHORIZED_KEY\" > /root/.ssh/authorized_keys && exec /usr/sbin/init"]
