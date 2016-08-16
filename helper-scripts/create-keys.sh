#!/bin/bash
export NODE_ENV=${NODE_ENV:-production}

error () {
  echo ERROR: "$@"
  exit 1
}

keyname=$(cd .. && node -e "console.log(require('taskcluster-base').config().app.id)")-ssh-key

ssh-keygen -t rsa -b 4096 -f $keyname -C ""

for region in $(cd .. && node -e "console.log(require('taskcluster-base').config().app.allowedRegions.join('\n'))") ; do
  echo Creating key $keyname in $region
  aws --region $region ec2 import-key-pair --key-name $keyname --public-key-material "$(cat $keyname.pub | grep -v 'PUBLIC KEY' | tr -d '\n')"
  if [ $? -eq 0 ] ; then
    echo Success
  else
    error creating key $keyname in $region
  fi
done
