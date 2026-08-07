# No dependencies to install, so the image is the runtime plus one file.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY server.js ./
EXPOSE 9000
CMD ["node", "server.js"]
