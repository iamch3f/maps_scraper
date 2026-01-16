# Google Maps Scraper API - VPS Optimized
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV WORKERS=3
ENV MAX_CONCURRENT_JOBS=5

# Install system dependencies (fonts for rendering)
RUN apt-get update && apt-get install -y \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy source code
COPY . .

# Create data directory
RUN mkdir -p /data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Run as non-root for security
RUN groupadd -r scraper && useradd -r -g scraper scraper
RUN chown -R scraper:scraper /app /data
USER scraper

# Start the optimized server
CMD ["node", "server.js"]
