# Use official Node.js runtime as base image
# Use 20-slim (Debian-based) for better compatibility with global CLI tools
FROM node:20-slim

# Set labels
LABEL maintainer="CODENEX-AI-PROXY-API Team"
LABEL description="Docker image for CODENEX-AI-PROXY-API server"

# Set working directory
WORKDIR /app

# Install global CLI tools for Claude Code provider
# Claude Code CLI is required for ai-sdk-provider-claude-code
RUN npm install -g @anthropic-ai/claude-code

# Copy package.json and package-lock.json (if exists)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

USER root

# Create directory for storing logs and system prompt files
RUN mkdir -p /app/logs

# Expose ports
EXPOSE 3000 8085 8086 19876-19880

# Add health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# Set startup command
# Start server with default configuration, supports configuration via environment variables
# Pass arguments via environment variables, e.g.: docker run -e ARGS="--api-key mykey --port 8080" ...
CMD ["sh", "-c", "node src/master.js $ARGS"]