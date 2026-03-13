#!/bin/bash
# Ensure /var/run/sshd exists
mkdir -p /var/run/sshd

# Start sshd as root
/usr/sbin/sshd -p 2222

# Drop to the original command
exec "$@"
