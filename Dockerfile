# Builder
FROM node:current-slim
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Production image
FROM node:current-slim
WORKDIR /usr/src/app
COPY package*.json ./
COPY .env ./.env
COPY keys/** ./keys/
RUN npm install --only=production
COPY --from=0 /usr/src/app/dist ./dist
EXPOSE 9022
CMD npm start
