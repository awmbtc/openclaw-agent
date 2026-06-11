FROM node:20-alpine

# 安装 openclaw 框架
RUN npm install -g openclaw@latest

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src ./src

EXPOSE 8080
CMD ["node", "src/index.js"]
