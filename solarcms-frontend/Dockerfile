# The built frontend, served by nginx, for running the whole stack in
# containers (docs/CAPACITY_AND_DEPLOYMENT.md §5.5). On AWS the same `dist/`
# goes to S3 + CloudFront instead, built with VITE_API_BASE and VITE_WS_BASE
# pointing at the API's own domain (§5.3).
#
#   docker build -t solarcms-frontend solarcms-frontend
#   docker run -p 8080:80 -e API_UPSTREAM=http://api:8000 solarcms-frontend
FROM node:20.18.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE=/api
ARG VITE_WS_BASE=
ENV VITE_API_BASE=$VITE_API_BASE VITE_WS_BASE=$VITE_WS_BASE
RUN npm run build

FROM nginx:1.27.2-alpine
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV API_UPSTREAM=http://api:8000
EXPOSE 80
