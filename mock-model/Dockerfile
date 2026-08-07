# No dependencies to install, so there is nothing to build — the image is just
# the runtime plus one file. Keeps it buildable with no registry access.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
