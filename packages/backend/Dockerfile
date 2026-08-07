FROM node:26.5.1@sha256:a9875b5ccb02aa527cf7f2297b16ae425a0ff3da2f7d87fce3df41f04ffa0524
ARG zipbundle
ENV PEERS_NUMBER 20
ENV TOR_TEST_MODE regular
ENV TOR_BIN_NAME tor
ENV VANGUARDS_ENABLED auto
ENV NUM_ENTRY_GUARDS 0

RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
RUN unzip awscliv2.zip
RUN ./aws/install

RUN mkdir /app
ADD ${zipbundle} /tmp
WORKDIR /app
RUN unzip /tmp/${zipbundle} && rm /tmp/${zipbundle}

COPY 3rd-party /3rd-party
ENV DEBUG=backend*
CMD timeout 4h node /app/backend-bundle/bundle.cjs -p ${PEERS_NUMBER} -m ${TOR_TEST_MODE} -t ${TOR_BIN_NAME} -v ${VANGUARDS_ENABLED} -g ${NUM_ENTRY_GUARDS} && aws s3 cp /app/tor_*.json s3://tor-connection-data