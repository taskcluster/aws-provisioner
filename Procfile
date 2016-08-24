web: node lib/main server | ./node_modules/.bin/bunyan -o short -l info
provisioner: node lib/main provisioner | ./node_modules/.bin/bunyan -o short -c "this.level > 20 || this.capacityForTypeLog"
