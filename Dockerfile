# Local development image only. Vercel builds the app natively and does not use this file.
FROM node:24-alpine

WORKDIR /app

# Install dependencies in a cached layer. In Compose, the source tree is
# bind-mounted over /app and node_modules is kept in a named volume.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

# Bind to all interfaces so the container port is reachable from the host.
CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0", "--port", "3000"]

