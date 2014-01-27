FROM lightsofapollo/node:0.10.24
MAINTAINER Jonas Finnemann Jensen [:jonasfj]

ADD . provisioner
RUN cd provisioner; npm install
CMD cd provisioner; node server.js