# One-time Fomo login over noVNC.
#
# The homelab has no display, and signing into Fomo needs a human clicking
# through Google OAuth in a visible browser. This container supplies the display:
# Xvfb for a framebuffer, x11vnc to serve it, noVNC to put that in a web page.
#
# It exists to be run occasionally and then stopped. It is NOT part of the
# steady-state stack - see the `login` compose profile and README.md.
#
# Same Playwright base as the sidecar so the browser writing the profile is the
# same build as the browser that will later read it.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

USER root

# ARG, not ENV: needed only while apt runs, and it should not persist into the
# running container. Without it, tzdata - pulled in as a dependency of the X11
# packages - opens an interactive "select your geographic area" prompt and the
# build hangs forever rather than failing. It cost 20 minutes of a build that
# looked merely slow.
ARG DEBIAN_FRONTEND=noninteractive

# fluxbox gives the browser a window manager; without one Chrome opens with no
# decorations and OAuth popups can end up unfocusable.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox novnc websockify openssl ca-certificates x11-utils \
    && rm -rf /var/lib/apt/lists/*

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# noVNC's web page. Not published to the host - cloudflared reaches it over the
# compose network, so the only route in is the tunnel (and whatever sits in
# front of it).
EXPOSE 6080

ENV DISPLAY=:99 \
    SCREEN=1280x900x24 \
    PROFILE_DIR=/profile \
    START_URL=https://fomo.family/token

CMD ["/usr/local/bin/start.sh"]
