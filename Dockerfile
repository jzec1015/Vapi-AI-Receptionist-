FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.mjs booking.mjs trial.mjs ./
COPY templates/emma-assistant.json templates/emma-prompt.txt ./templates/
EXPOSE 8080
CMD ["node", "server.mjs"]
