FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install --production --no-cache

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
