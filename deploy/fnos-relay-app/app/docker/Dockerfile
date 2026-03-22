FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY remote ./remote

EXPOSE 8080

CMD ["node", "server.mjs"]
