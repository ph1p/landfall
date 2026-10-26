# An rpm "server" with systemd for dnf's automatic updates: fedora (dnf5) or rockylinux:9 (dnf 4).
ARG BASE=fedora:42
FROM $BASE
RUN dnf install -y -q systemd openssh-server >/dev/null && dnf clean all && systemctl enable sshd
CMD ["sh", "-c", "install -d -m 700 /root/.ssh && printf '%s\\n' \"$AUTHORIZED_KEY\" > /root/.ssh/authorized_keys && exec /usr/sbin/init"]
