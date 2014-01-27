
docker-build:
	docker build -t docker-aws-provisioner .

test: docker-build
	 docker run -e AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY docker-aws-provisioner bash -c "cd provisioner; node tests

.PHONY: test docker-build
