# The Golang build container.
# TODO This should be split out into the cosmos-connector.
FROM golang:stretch

WORKDIR /usr/src/app
COPY go.mod go.sum ./
RUN go mod download

COPY Makefile* *.go ./
COPY x/ x/
COPY cmd/ cmd/
COPY lib/*.go lib/
COPY lib/daemon/ lib/daemon/
COPY lib/helper/ lib/helper/
RUN make compile-go install
