FROM node:22-alpine

# Create a non-root user to run the process
RUN addgroup -S addon && adduser -S addon -G addon

WORKDIR /app

# Install dependencies first (layer-cached unless package files change)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY index.js simkl.js db.js ./
COPY public/ ./public/

# Volume for persistent token storage (tokens.json lives here)
RUN mkdir /data && chown addon:addon /data
VOLUME /data
ENV DATA_DIR=/data

# Drop privileges
USER addon

EXPOSE 7000

CMD ["node", "index.js"]
