FROM node:14

WORKDIR /app
COPY package*.json ./
#RUN mkdir repos
#RUN cd repos
#RUN git clone --bare https://github.com/jquery/jquery-mobile
#RUN mkdir -p staging
RUN npm install

COPY . .

RUN scripts/setup-mobile.js

EXPOSE 3000
CMD [ "node", "server.js", "-r", "/app/repos", "-s", "/app/staging" ]
