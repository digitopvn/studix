# Build only the standalone marketing site:
# docker build -t studix-marketing .
# docker run --rm -p 4321:80 studix-marketing
FROM node:22-alpine AS site

ARG STUDIX_APP_URL=https://app.studix.digitop.ai/
ENV STUDIX_APP_URL=${STUDIX_APP_URL}
WORKDIR /site
COPY apps/marketing/public/ ./

# The Cloudflare Worker normally injects this URL. Bake it into the static image
# so the dashboard links and MCP example work without running Wrangler.
RUN node -e 'const fs = require("node:fs"); const app = new URL(process.env.STUDIX_APP_URL); if (!["http:", "https:"].includes(app.protocol)) throw new Error("STUDIX_APP_URL must be HTTP(S)"); const appUrl = app.toString(); const mcpUrl = new URL("mcp", appUrl).toString(); for (const file of ["index.html", "en/index.html"]) { const html = fs.readFileSync(file, "utf8"); fs.writeFileSync(file, html.replaceAll("https://app.studix.digitop.ai/mcp", mcpUrl).replaceAll("https://app.studix.digitop.ai/", appUrl)); } fs.writeFileSync("config.json", JSON.stringify({ appUrl }));'

FROM nginx:1.27-alpine
COPY apps/marketing/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=site /site/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
