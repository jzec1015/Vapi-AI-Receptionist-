FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.mjs booking.mjs trial.mjs ./
COPY templates/emma-assistant.json templates/emma-prompt.txt ./templates/
COPY templates/fonts/dm-sans.woff2 templates/fonts/manrope.woff2 ./templates/fonts/
EXPOSE 8080
CMD ["node", "server.mjs"]
