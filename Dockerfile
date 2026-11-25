# DataCanvas in a container. Build it from the already packaged app:
#
#   pnpm run package                       # makes .package/ (see docs/releasing.md)
#   docker build -t datacanvas .
#   docker run --rm -p 127.0.0.1:4747:4747 -v datacanvas-data:/data datacanvas
#
# Read docs/docker.md first. In short: publish the port to 127.0.0.1 ONLY (as above). Inside the container the app listens on
# all interfaces, because a published port reaches it through the container's own network interface; the Host check, the
# session token and the token of /mcp still apply, but nothing else protects a port that is published to your network.
FROM node:22-alpine

# `--host 0.0.0.0` is accepted only with this variable (packages/cli/src/host-option.ts); it is set here and nowhere else.
ENV NODE_ENV=production \
    DATACANVAS_HOME=/data \
    DATACANVAS_ALLOW_ANY_INTERFACE=1

WORKDIR /app
# The packaged app: bin/datacanvas.mjs, web/ (the Next.js server) and node_modules/ (what the server needs). Nothing to install.
COPY .package/ /app/
# `datacanvas` on the PATH, so `docker exec -i <container> datacanvas mcp` works (docs/docker.md).
RUN ln -s /app/bin/datacanvas.mjs /usr/local/bin/datacanvas \
 && mkdir -p /data \
 && chown node:node /data

# Not root. The data folder is the volume: connection profiles, workspaces and snapshots live there.
USER node
VOLUME /data
EXPOSE 4747

ENTRYPOINT ["datacanvas"]
CMD ["--host", "0.0.0.0", "--no-open", "--port", "4747"]
