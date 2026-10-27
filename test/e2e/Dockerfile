# Throwaway "server" for end-to-end tests: sshd + its own Docker daemon.
FROM docker:28-dind
RUN apk add --no-cache openssh bash shadow curl musl-utils coreutils ufw openssl rsync openrc busybox-openrc \
 && ssh-keygen -A \
 && mkdir /e2e && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj /CN=e2e \
      -addext "subjectAltName=DNS:*.test,DNS:*.box.test,DNS:*.auto.test,DNS:*.127-0-0-1.sslip.io" -keyout /e2e/key.pem -out /e2e/cert.pem 2>/dev/null \
 && (addgroup -S docker 2>/dev/null || true) \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /etc/ssh/sshd_config \
 && echo 'PerSourcePenalties no' >> /etc/ssh/sshd_config \
 && usermod -p '*' root
COPY entry.sh /entry.sh
ENV DOCKER_TLS_CERTDIR=""
ENTRYPOINT ["/entry.sh"]
