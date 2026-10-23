# Throwaway "server" for end-to-end tests: sshd + its own Docker daemon.
FROM docker:28-dind
RUN apk add --no-cache openssh bash shadow curl musl-utils coreutils ufw \
 && ssh-keygen -A \
 && (addgroup -S docker 2>/dev/null || true) \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && echo 'PerSourcePenalties no' >> /etc/ssh/sshd_config \
 && usermod -p '*' root
COPY entry.sh /entry.sh
ENV DOCKER_TLS_CERTDIR=""
ENTRYPOINT ["/entry.sh"]
